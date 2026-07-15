// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recallApi", () => ({
  fetchDueRecall: vi.fn(),
  gradeRecall: vi.fn(),
  snoozeRecall: vi.fn()
}));

import type { MemoryPromptCardDto, MemoryPromptDto, ReviewStateDto } from "@whetstone/contracts";

import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";
import { RecallPage } from "./RecallPage";

const mockedFetch = vi.mocked(fetchDueRecall);
const mockedGrade = vi.mocked(gradeRecall);
const mockedSnooze = vi.mocked(snoozeRecall);

const review: ReviewStateDto = {
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
};

function makeCard(overrides: Partial<MemoryPromptCardDto> = {}): MemoryPromptCardDto {
  return {
    answerText: "to reveal a secret",
    chunkId: null,
    cueText: "spill the beans",
    noteId: "note-1",
    promptId: "prompt-1",
    review,
    ...overrides
  };
}

function makePrompt(overrides: Partial<MemoryPromptDto> = {}): MemoryPromptDto {
  return {
    answerText: "to reveal a secret",
    cardStatus: "active",
    chunkId: null,
    cueText: "spill the beans",
    lifecycle: "ready",
    noteId: "note-1",
    promptId: "prompt-1",
    review,
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
  it("shows a loading state while due prompts load", () => {
    mockedFetch.mockReturnValue(new Promise<ReadonlyArray<MemoryPromptCardDto>>(() => {}));
    render(<RecallPage />);
    expect(screen.getByText("Gathering what's due…")).toBeDefined();
  });

  it("shows an error state when due prompts cannot load", async () => {
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
    mockedFetch.mockResolvedValue([makeCard()]);
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Show answer" })).toBeDefined();
    expect(within(card).getByRole("button", { name: "Snooze" })).toBeDefined();
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(within(card).queryByRole("button", { name: label })).toBeNull();
    }
    expect(within(card).queryByText("to reveal a secret")).toBeNull();
  });

  it("keeps the loaded prompt stable across a parent rerender", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    const view = render(<RecallPage />);

    expect(await screen.findByText("spill the beans")).toBeDefined();
    view.rerender(<RecallPage />);

    expect(screen.getByText("spill the beans")).toBeDefined();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("reveals the answer, focuses it, and shows the four grade buttons after Show answer (#525)", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));

    const answer = within(card).getByLabelText("Answer");
    expect(within(answer).getByText("to reveal a secret")).toBeDefined();
    expect(document.activeElement).toBe(answer);
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(within(card).getByRole("button", { name: label })).toBeDefined();
    }
    expect(within(card).queryByRole("button", { name: "Show answer" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Snooze" })).toBeDefined();
  });

  it("uses the card cue as the front and the answer text as the revealed back (#595)", async () => {
    mockedFetch.mockResolvedValue([
      makeCard({ answerText: "spill the beans", cueText: "Say you kept a secret in." })
    ]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const front = await screen.findByText("Say you kept a secret in.");
    const card = front.closest("li") as HTMLElement;
    expect(within(card).queryByText("spill the beans")).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    expect(within(card).getByText("spill the beans")).toBeDefined();
  });

  it("reveals the required answer and remains gradeable (#595)", async () => {
    mockedFetch.mockResolvedValue([
      makeCard({ answerText: "a way to reduce risk", cueText: "Mitigation (noun)" })
    ]);
    mockedGrade.mockResolvedValue(makePrompt());
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("Mitigation (noun)")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));

    expect(within(card).getByText("a way to reduce risk")).toBeDefined();
    expect(within(card).queryByText(/No saved answer/)).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Good" }));
    expect(mockedGrade).toHaveBeenCalledWith("prompt-1", "good");
  });

  it("grades a prompt after revealing it and removes it from today's list", async () => {
    mockedFetch.mockResolvedValue([
      makeCard(),
      makeCard({ cueText: "by and large", promptId: "prompt-2" })
    ]);
    mockedGrade.mockResolvedValue(makePrompt());
    const user = userEvent.setup();
    render(<RecallPage />);

    const firstCard = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(firstCard).getByRole("button", { name: "Show answer" }));
    await user.click(within(firstCard).getByRole("button", { name: "Good" }));

    expect(mockedGrade).toHaveBeenCalledWith("prompt-1", "good");
    expect(screen.queryByText("spill the beans")).toBeNull();
    expect(screen.getByText("by and large")).toBeDefined();
  });

  it("reveals with the keyboard (Enter on the Show answer control) (#525)", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    within(card).getByRole("button", { name: "Show answer" }).focus();
    await user.keyboard("{Enter}");

    expect(within(card).getByText("to reveal a secret")).toBeDefined();
  });

  it("maps the number keys 1–4 to the four grades after reveal", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    mockedGrade.mockResolvedValue(makePrompt());
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.keyboard("3");

    expect(mockedGrade).toHaveBeenCalledWith("prompt-1", "good");
  });

  it("ignores non-grade keys after reveal", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.keyboard("9");

    expect(mockedGrade).not.toHaveBeenCalled();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });

  it("snoozes from the revealed phase and removes the prompt", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    mockedSnooze.mockResolvedValue(makePrompt());
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.click(within(card).getByRole("button", { name: "Snooze" }));

    expect(mockedSnooze).toHaveBeenCalledWith("prompt-1");
    expect(screen.queryByText("spill the beans")).toBeNull();
  });

  it("snoozes a prompt and removes it from today's list", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    mockedSnooze.mockResolvedValue(makePrompt());
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Snooze" }));

    expect(mockedSnooze).toHaveBeenCalledWith("prompt-1");
    expect(screen.queryByText("spill the beans")).toBeNull();
    expect(await screen.findByText(/Nothing due/)).toBeDefined();
  });

  it("surfaces an action error and keeps the prompt when grading fails", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    mockedGrade.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<RecallPage />);

    const card = (await screen.findByText("spill the beans")).closest("li") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Show answer" }));
    await user.click(within(card).getByRole("button", { name: "Again" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });

  it("surfaces an action error and keeps the prompt when snoozing fails", async () => {
    mockedFetch.mockResolvedValue([makeCard()]);
    mockedSnooze.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Snooze" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });
});
