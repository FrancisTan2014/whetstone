// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RelatedMaterialRelationsResponse,
  RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { RelatedMaterialDisclosure } from "./RelatedMaterialDisclosure";
import { fetchRelatedRelations, fetchRelatedSenses } from "./relatedMaterialApi";

vi.mock("./relatedMaterialApi", () => ({
  fetchRelatedSenses: vi.fn(),
  fetchRelatedRelations: vi.fn()
}));

const fetchSensesMock = vi.mocked(fetchRelatedSenses);
const fetchRelationsMock = vi.mocked(fetchRelatedRelations);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const bornSenses: RelatedMaterialSensesResponse = {
  status: "found",
  surface: "born",
  senses: [
    {
      offset: "02636952",
      partOfSpeech: "verb",
      definition: "give birth to a child",
      examples: ["she bore a son"],
      lemmas: ["bear", "have"]
    },
    {
      offset: "01899262",
      partOfSpeech: "adjective",
      definition: "brought into existence",
      examples: [],
      lemmas: ["born"]
    }
  ]
};

const bornRelations: RelatedMaterialRelationsResponse = {
  status: "found",
  surface: "born",
  selectedLemma: "bear",
  partOfSpeech: "verb",
  groups: [
    {
      relation: "inflection",
      direction: "lateral",
      notes: [{ noteId: "note-1", word: "bear", context: "a mother bears a child" }]
    },
    {
      relation: "synonym",
      direction: "lateral",
      notes: [{ noteId: "note-2", word: "birth", context: null }]
    }
  ]
};

function renderDisclosure(answer = "born"): void {
  render(<RelatedMaterialDisclosure answerDoc={createTextDocument(answer)} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RelatedMaterialDisclosure", () => {
  it("stays collapsed and performs no request until opened", () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    renderDisclosure();

    const toggle = screen.getByRole("button", { name: "Find related material" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(fetchSensesMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Related material" })).toBeNull();
  });

  it("triggers sense discovery on open and lists every sense with its evidence, none preselected", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));

    expect(fetchSensesMock).toHaveBeenCalledTimes(1);
    const verb = await screen.findByRole("radio", { name: /give birth to a child/ });
    const adjective = screen.getByRole("radio", { name: /brought into existence/ });
    // Every returned sense choice appears with lemma(s), part of speech, definition, and examples.
    expect(within(verb.closest("label") as HTMLElement).getByText("bear, have")).toBeTruthy();
    expect(screen.getByText("“she bore a son”")).toBeTruthy();
    // Never preselect or infer a sense, and no relations request before one is chosen.
    expect((verb as HTMLInputElement).checked).toBe(false);
    expect((adjective as HTMLInputElement).checked).toBe(false);
    expect(fetchRelationsMock).not.toHaveBeenCalled();
  });

  it("after explicit sense selection shows the surface/lemma header and the typed reasons", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    fetchRelationsMock.mockResolvedValue(bornRelations);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("radio", { name: /give birth to a child/ }));

    expect(fetchRelationsMock).toHaveBeenCalledWith(expect.anything(), {
      offset: "02636952",
      partOfSpeech: "verb"
    });
    // "born -> bear . verb" header.
    await waitFor(() =>
      expect(
        screen.getByText(
          (_, element) => element?.textContent === "born → bear · verb"
        )
      ).toBeTruthy()
    );
    // The inflection reason is labelled with the selected part of speech; the synonym reason is fixed.
    expect(screen.getByRole("heading", { name: "same verb lemma" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "synonym" })).toBeTruthy();
  });

  it("renders each related note's word and context and an Open note link that never blocks the draft", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    fetchRelationsMock.mockResolvedValue(bornRelations);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("radio", { name: /give birth to a child/ }));

    expect(await screen.findByText("bear")).toBeTruthy();
    expect(screen.getByText("a mother bears a child")).toBeTruthy();
    const openNote = screen.getByRole("link", { name: "Open note: bear" });
    expect(openNote.getAttribute("href")).toBe("#/notes?open=note-1");
    expect(openNote.getAttribute("target")).toBe("_blank");
    expect(openNote.getAttribute("rel")).toBe("noopener noreferrer");
    // The related material never offers Use existing material, and never a card-preselecting or save control.
    expect(screen.queryByRole("button", { name: /Use existing material/ })).toBeNull();
  });

  it("keeps a long definition fully readable", async () => {
    const longDefinition = `to bring forth ${"a very long clause ".repeat(12)}offspring`;
    fetchSensesMock.mockResolvedValue({
      status: "found",
      surface: "born",
      senses: [
        {
          offset: "02636952",
          partOfSpeech: "verb",
          definition: longDefinition,
          examples: [],
          lemmas: ["bear"]
        }
      ]
    });
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));

    expect(await screen.findByText(longDefinition)).toBeTruthy();
  });

  it("stays quiet for an eligible surface with no sense", async () => {
    fetchSensesMock.mockResolvedValue({ status: "not_found" });
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));

    expect(await screen.findByText("No related material for this word.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("offers Retry when sense discovery is unavailable and never blocks the draft", async () => {
    fetchSensesMock.mockResolvedValueOnce({ status: "unavailable" });
    fetchSensesMock.mockResolvedValueOnce(bornSenses);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("radio", { name: /give birth to a child/ })).toBeTruthy();
    expect(fetchSensesMock).toHaveBeenCalledTimes(2);
  });

  it("treats an empty relations result as a quiet no-result", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    fetchRelationsMock.mockResolvedValue({
      status: "found",
      surface: "born",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: []
    });
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("radio", { name: /give birth to a child/ }));

    expect(await screen.findByText("No related saved notes for this sense.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open note/ })).toBeNull();
  });

  it("offers Retry when the relations request is unavailable", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    fetchRelationsMock.mockResolvedValueOnce({ status: "unavailable" });
    fetchRelationsMock.mockResolvedValueOnce(bornRelations);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("radio", { name: /give birth to a child/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "same verb lemma" })).toBeTruthy();
    expect(fetchRelationsMock).toHaveBeenCalledTimes(2);
  });

  it("stays quiet for a not_found relations result", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    fetchRelationsMock.mockResolvedValue({ status: "not_found" });
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("radio", { name: /give birth to a child/ }));

    expect(await screen.findByText("No related saved notes for this sense.")).toBeTruthy();
  });

  it("re-requests relations when the sense changes and ignores the stale earlier response", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    const first = deferred<RelatedMaterialRelationsResponse>();
    const second = deferred<RelatedMaterialRelationsResponse>();
    fetchRelationsMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(await screen.findByRole("radio", { name: /give birth to a child/ }));
    // Switch to the other sense before the first relations response arrives.
    await userEvent.click(screen.getByRole("radio", { name: /brought into existence/ }));

    // The stale first response resolves LAST but must be ignored (sense already changed).
    second.resolve({
      status: "found",
      surface: "born",
      selectedLemma: "born",
      partOfSpeech: "adjective",
      groups: [
        {
          relation: "synonym",
          direction: "lateral",
          notes: [{ noteId: "note-9", word: "innate", context: null }]
        }
      ]
    });
    first.resolve(bornRelations);

    await waitFor(() => expect(screen.getByText("innate")).toBeTruthy());
    // The superseded first response's notes never appear.
    expect(screen.queryByText("a mother bears a child")).toBeNull();
    expect(screen.queryByRole("heading", { name: "same verb lemma" })).toBeNull();
  });

  it("resets the disclosure when the Answer changes to a different word", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    // The composer re-keys the disclosure by the projected surface, so a changed Answer remounts it. Passing
    // an explicit key mirrors that wiring: the disclosure returns to collapsed with no selection.
    const { rerender } = render(
      <RelatedMaterialDisclosure answerDoc={createTextDocument("born")} key="born" />
    );

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await screen.findByRole("radio", { name: /give birth to a child/ });

    rerender(<RelatedMaterialDisclosure answerDoc={createTextDocument("river")} key="river" />);

    expect(
      screen.getByRole("button", { name: "Find related material" }).getAttribute("aria-expanded")
    ).toBe("false");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("keeps the loaded senses when reopened without re-requesting", async () => {
    fetchSensesMock.mockResolvedValue(bornSenses);
    renderDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await screen.findByRole("radio", { name: /give birth to a child/ });
    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));
    await userEvent.click(screen.getByRole("button", { name: "Find related material" }));

    expect(await screen.findByRole("radio", { name: /give birth to a child/ })).toBeTruthy();
    expect(fetchSensesMock).toHaveBeenCalledTimes(1);
  });
});
