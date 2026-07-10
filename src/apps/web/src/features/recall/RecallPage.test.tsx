// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recallApi", () => ({
  fetchDueRecall: vi.fn(),
  gradeRecall: vi.fn(),
  snoozeRecall: vi.fn()
}));

import type { RecallItemDto } from "@whetstone/contracts";

import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";
import { RecallPage } from "./RecallPage";

const mockedFetch = vi.mocked(fetchDueRecall);
const mockedGrade = vi.mocked(gradeRecall);
const mockedSnooze = vi.mocked(snoozeRecall);

function makeItem(overrides: Partial<RecallItemDto> = {}): RecallItemDto {
  return {
    chunkId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    gloss: null,
    id: "r1",
    kind: "word",
    provenanceEntryId: null,
    review: {
      due: "2026-01-01T00:00:00.000Z",
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: "new",
      lastReviewedAt: null
    },
    text: "spill the beans",
    cue: null,
    useContext: null,
    category: null,
    tags: null,
    sourceProposalCandidateId: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("RecallPage", () => {
  it("shows a loading state while due items load", () => {
    mockedFetch.mockReturnValue(new Promise<ReadonlyArray<RecallItemDto>>(() => {}));
    render(<RecallPage />);
    expect(screen.getByText("Gathering what's due…")).toBeDefined();
  });

  it("shows an error state when due items cannot load", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    render(<RecallPage />);
    expect(await screen.findByText(/Could not load your recall items/)).toBeDefined();
  });

  it("shows the calm empty state when nothing is due", async () => {
    mockedFetch.mockResolvedValue([]);
    render(<RecallPage />);
    expect(await screen.findByText(/Nothing due/)).toBeDefined();
    expect(screen.queryByRole("list", { name: "Items due to recall" })).toBeNull();
  });

  it("shows the prompt with Show answer and Snooze but no grade buttons before reveal (#525)", async () => {
    // A self-grade is meaningless without a retrieval attempt: grades are gated behind the reveal.
    mockedFetch.mockResolvedValue([makeItem({ gloss: "to reveal a secret" })]);
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Show answer" })).toBeDefined();
    expect(within(card).getByRole("button", { name: "Snooze" })).toBeDefined();
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(within(card).queryByRole("button", { name: label })).toBeNull();
    }
    // The back (gloss) is not revealed yet.
    expect(within(card).queryByText("to reveal a secret")).toBeNull();
  });

  it("reveals the answer and shows the four grade buttons after Show answer (#525)", async () => {
    mockedFetch.mockResolvedValue([makeItem({ gloss: "to reveal a secret" })]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));

    // The back appears, and only now do the four FSRS rating buttons enter the tree.
    expect(within(card).getByText("to reveal a secret")).toBeDefined();
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(within(card).getByRole("button", { name: label })).toBeDefined();
    }
    // The reveal control is gone; Snooze stays.
    expect(within(card).queryByRole("button", { name: "Show answer" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Snooze" })).toBeDefined();
  });

  it("production card (cue present): front is the cue; the target is on the revealed back (#525)", async () => {
    mockedFetch.mockResolvedValue([
      makeItem({ cue: "Say you kept a secret in.", text: "spill the beans", gloss: "reveal it" })
    ]);
    const user = userEvent.setup();
    render(<RecallPage />);

    // Front is the cue; the target text is NOT shown before reveal.
    const front = await screen.findByText("Say you kept a secret in.");
    const card = front.closest("li") as HTMLElement;
    expect(within(card).queryByText("spill the beans")).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    expect(within(card).getByText("spill the beans")).toBeDefined();
    expect(within(card).getByText("reveal it")).toBeDefined();
  });

  it("answerless card: the reveal shows a self-check hint and is still gradeable (#525)", async () => {
    mockedFetch.mockResolvedValue([
      makeItem({ cue: null, gloss: null, useContext: null, text: "Mitigation (noun)" })
    ]);
    mockedGrade.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("Mitigation (noun)")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));

    expect(within(card).getByText(/No saved answer/)).toBeDefined();
    await user.click(within(card).getByRole("button", { name: "Good" }));
    expect(mockedGrade).toHaveBeenCalledWith("r1", "good");
  });

  it("grades an item after revealing it and removes it from today's list", async () => {
    mockedFetch.mockResolvedValue([makeItem(), makeItem({ id: "r2", text: "by and large" })]);
    mockedGrade.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    const firstCard = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(firstCard).getByRole("button", { name: "Show answer" }));
    await user.click(within(firstCard).getByRole("button", { name: "Good" }));

    expect(mockedGrade).toHaveBeenCalledWith("r1", "good");
    expect(screen.queryByText("spill the beans")).toBeNull();
    expect(screen.getByText("by and large")).toBeDefined();
  });

  it("reveals with the keyboard (Enter on the Show answer control) (#525)", async () => {
    mockedFetch.mockResolvedValue([makeItem({ gloss: "to reveal a secret" })]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    within(card).getByRole("button", { name: "Show answer" }).focus();
    await user.keyboard("{Enter}");

    expect(within(card).getByText("to reveal a secret")).toBeDefined();
  });

  it("maps the number keys 1–4 to the four grades after reveal", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedGrade.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    // "3" is Good (Again/Hard/Good/Easy).
    await user.keyboard("3");

    expect(mockedGrade).toHaveBeenCalledWith("r1", "good");
  });

  it("ignores non-grade keys after reveal", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.keyboard("9");

    expect(mockedGrade).not.toHaveBeenCalled();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });

  it("snoozes from the revealed phase and removes the item", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedSnooze.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.click(within(card).getByRole("button", { name: "Snooze" }));

    expect(mockedSnooze).toHaveBeenCalledWith("r1");
    expect(screen.queryByText("spill the beans")).toBeNull();
  });

  it("snoozes an item and removes it from today's list", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedSnooze.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Snooze" }));

    expect(mockedSnooze).toHaveBeenCalledWith("r1");
    expect(screen.queryByText("spill the beans")).toBeNull();
    expect(await screen.findByText(/Nothing due/)).toBeDefined();
  });

  it("surfaces an action error and keeps the item when grading fails", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedGrade.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.click(within(card).getByRole("button", { name: "Again" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });

  it("surfaces an action error and keeps the item when snoozing fails", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedSnooze.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Snooze" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });
});
