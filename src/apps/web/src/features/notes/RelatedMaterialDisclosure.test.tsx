// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTextDocument } from "@whetstone/document";

import type {
  RelatedMaterialRelationsResponse,
  RelatedMaterialSenseDto
} from "@whetstone/contracts";

import { RelatedMaterialDisclosure } from "./RelatedMaterialDisclosure";
import { fetchRelatedRelations, fetchRelatedSenses } from "./relatedMaterialApi";

vi.mock("./relatedMaterialApi", () => ({
  fetchRelatedSenses: vi.fn(),
  fetchRelatedRelations: vi.fn()
}));

const fetchSensesMock = vi.mocked(fetchRelatedSenses);
const fetchRelationsMock = vi.mocked(fetchRelatedRelations);

const answerDoc = createTextDocument("bear");

const verbSense: RelatedMaterialSenseDto = {
  offset: "02000001",
  partOfSpeech: "verb",
  definition: "give birth to",
  examples: ["she bore a son"],
  lemmas: ["bear", "birth"]
};

const nounSense: RelatedMaterialSenseDto = {
  offset: "01000002",
  partOfSpeech: "noun",
  definition: "a large mammal",
  examples: [],
  lemmas: ["bear"]
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDisclosure(): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(<RelatedMaterialDisclosure answerDoc={answerDoc} />);
  return user;
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Find related material" }));
}

describe("RelatedMaterialDisclosure (#716)", () => {
  it("fetches no senses until the learner opens it", () => {
    renderDisclosure();

    expect(fetchSensesMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/choose a meaning/i)).toBeNull();
  });

  it("fetches senses once on open, toggles the label, and hides without refetching", async () => {
    fetchSensesMock.mockResolvedValue({ status: "found", surface: "bear", senses: [verbSense] });
    const user = renderDisclosure();

    await open(user);
    expect(await screen.findByText("give birth to")).not.toBeNull();
    expect(fetchSensesMock).toHaveBeenCalledTimes(1);

    const toggle = screen.getByRole("button", { name: "Hide related material" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(screen.queryByText("give birth to")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Find related material" }));
    expect(fetchSensesMock).toHaveBeenCalledTimes(1);
  });

  it("offers Retry when the senses lookup is unavailable and refetches on Retry", async () => {
    fetchSensesMock
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce({ status: "found", surface: "bear", senses: [verbSense] });
    const user = renderDisclosure();

    await open(user);
    const retry = await screen.findByRole("button", { name: "Retry" });
    await user.click(retry);

    expect(await screen.findByText("give birth to")).not.toBeNull();
    expect(fetchSensesMock).toHaveBeenCalledTimes(2);
  });

  it("shows a quiet message for a word with no senses", async () => {
    fetchSensesMock.mockResolvedValue({ status: "not_found" });
    const user = renderDisclosure();

    await open(user);
    expect(await screen.findByText("No related material for this word.")).not.toBeNull();
  });

  it("shows the quiet message for an unsupported surface too", async () => {
    fetchSensesMock.mockResolvedValue({ status: "unsupported" });
    const user = renderDisclosure();

    await open(user);
    expect(await screen.findByText("No related material for this word.")).not.toBeNull();
  });

  it("renders typed related notes with saved word, context, and an Open-note link in a new tab", async () => {
    fetchSensesMock.mockResolvedValue({
      status: "found",
      surface: "bear",
      senses: [verbSense, nounSense]
    });
    fetchRelationsMock.mockResolvedValue({
      status: "found",
      surface: "born",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [
        {
          relation: "inflection",
          direction: "lateral",
          notes: [
            { noteId: "note-anchored", word: "born", context: "she was born in May" },
            { noteId: "note-standalone", word: "bore", context: null }
          ]
        }
      ]
    });
    const user = renderDisclosure();

    await open(user);
    await user.click(await screen.findByRole("button", { name: /give birth to/ }));

    expect(await screen.findByText("born → bear · verb")).not.toBeNull();
    expect(screen.getByText("same verb lemma")).not.toBeNull();
    expect(screen.getByText("born")).not.toBeNull();
    expect(screen.getByText("“she was born in May”")).not.toBeNull();

    const links = screen.getAllByRole("link", { name: "Open note" });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe("#/notes?open=note-anchored");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(fetchRelationsMock).toHaveBeenCalledWith(answerDoc, {
      offset: verbSense.offset,
      partOfSpeech: verbSense.partOfSpeech
    });
  });

  it("labels a hypernym group as a broader term", async () => {
    fetchSensesMock.mockResolvedValue({ status: "found", surface: "bear", senses: [nounSense] });
    fetchRelationsMock.mockResolvedValue({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "noun",
      groups: [
        {
          relation: "hypernym",
          direction: "broader",
          notes: [{ noteId: "n1", word: "mammal", context: null }]
        }
      ]
    });
    const user = renderDisclosure();

    await open(user);
    await user.click(await screen.findByRole("button", { name: /a large mammal/ }));

    expect(await screen.findByText("broader term")).not.toBeNull();
  });

  it("shows a quiet message when the selected sense relates no notes", async () => {
    fetchSensesMock.mockResolvedValue({ status: "found", surface: "bear", senses: [verbSense] });
    fetchRelationsMock.mockResolvedValue({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: []
    });
    const user = renderDisclosure();

    await open(user);
    await user.click(await screen.findByRole("button", { name: /give birth to/ }));

    expect(await screen.findByText("No related notes for this meaning.")).not.toBeNull();
  });

  it("shows a quiet message when the relations lookup is not_found", async () => {
    fetchSensesMock.mockResolvedValue({ status: "found", surface: "bear", senses: [verbSense] });
    fetchRelationsMock.mockResolvedValue({ status: "not_found" });
    const user = renderDisclosure();

    await open(user);
    await user.click(await screen.findByRole("button", { name: /give birth to/ }));

    expect(await screen.findByText("No related notes for this meaning.")).not.toBeNull();
  });

  it("offers Retry when the relations lookup is unavailable and refetches on Retry", async () => {
    fetchSensesMock.mockResolvedValue({ status: "found", surface: "bear", senses: [verbSense] });
    fetchRelationsMock.mockResolvedValueOnce({ status: "unavailable" }).mockResolvedValueOnce({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [
        {
          relation: "synonym",
          direction: "lateral",
          notes: [{ noteId: "n2", word: "carry", context: null }]
        }
      ]
    });
    const user = renderDisclosure();

    await open(user);
    await user.click(await screen.findByRole("button", { name: /give birth to/ }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("synonym")).not.toBeNull();
    expect(fetchRelationsMock).toHaveBeenCalledTimes(2);
  });

  it("marks the chosen sense as pressed and switches to the newly selected one", async () => {
    fetchSensesMock.mockResolvedValue({
      status: "found",
      surface: "bear",
      senses: [verbSense, nounSense]
    });
    fetchRelationsMock.mockResolvedValue({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "noun",
      groups: []
    });
    const user = renderDisclosure();

    await open(user);
    const nounButton = await screen.findByRole("button", { name: /a large mammal/ });
    await user.click(nounButton);

    await waitFor(() => expect(nounButton.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: /give birth to/ }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });
});

// A defensive-path check: the disclosure ignores a stale response so an out-of-order senses resolution never
// overwrites a newer one. Kept minimal — one interleaving proves the sequence guard holds.
describe("RelatedMaterialDisclosure stale-response guard", () => {
  it("keeps the latest sense group when the relations Retry resolves after the first request", async () => {
    fetchSensesMock.mockResolvedValue({ status: "found", surface: "bear", senses: [verbSense] });
    let resolveFirst!: (value: RelatedMaterialRelationsResponse) => void;
    const firstPending = new Promise<RelatedMaterialRelationsResponse>((resolve) => {
      resolveFirst = resolve;
    });
    fetchRelationsMock.mockReturnValueOnce(firstPending);
    const user = renderDisclosure();

    await open(user);
    await user.click(await screen.findByRole("button", { name: /give birth to/ }));
    expect(screen.getByText("Looking for related notes…")).not.toBeNull();

    fetchRelationsMock.mockResolvedValueOnce({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [
        {
          relation: "antonym",
          direction: "lateral",
          notes: [{ noteId: "n3", word: "die", context: null }]
        }
      ]
    });
    // Re-select to launch a second, winning request, then resolve the first (now stale) one.
    await user.click(screen.getByRole("button", { name: /give birth to/ }));
    resolveFirst({ status: "unavailable" });

    const groups = await screen.findByText("antonym");
    expect(within(groups.closest("div") as HTMLElement).queryByText("Retry")).toBeNull();
  });
});
