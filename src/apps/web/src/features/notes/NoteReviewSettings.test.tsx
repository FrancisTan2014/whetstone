// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  addNotePromptCardBack: vi.fn(),
  editNotePromptQuestion: vi.fn(),
  fetchNotePromptHistory: vi.fn(),
  fetchNotePromptSettings: vi.fn(),
  pauseNotePromptCard: vi.fn(),
  removeNotePromptCard: vi.fn(),
  restartNotePromptCard: vi.fn(),
  resumeNotePromptCard: vi.fn()
}));

import type {
  NotePromptSettingsDto,
  ReviewHistoryEventDto,
  ReviewHistoryPageDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import {
  addNotePromptCardBack,
  editNotePromptQuestion,
  fetchNotePromptHistory,
  fetchNotePromptSettings,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard
} from "../notesReview/notesReviewApi";
import { NoteReviewSettings } from "./NoteReviewSettings";

const mockedList = vi.mocked(fetchNotePromptSettings);
const mockedHistory = vi.mocked(fetchNotePromptHistory);
const mockedEdit = vi.mocked(editNotePromptQuestion);
const mockedPause = vi.mocked(pauseNotePromptCard);
const mockedResume = vi.mocked(resumeNotePromptCard);
const mockedRestart = vi.mocked(restartNotePromptCard);
const mockedRemove = vi.mocked(removeNotePromptCard);
const mockedAddBack = vi.mocked(addNotePromptCardBack);

function prompt(overrides: Partial<NotePromptSettingsDto> = {}): NotePromptSettingsDto {
  return {
    cardState: { state: "due" },
    promptId: "prompt-1",
    questionDoc: createTextDocument("What is a WAL?"),
    questionText: "What is a WAL?",
    reveal: { kind: "current_note" },
    ...overrides
  };
}

function resolveList(...prompts: NotePromptSettingsDto[]): void {
  mockedList.mockResolvedValue({ prompts });
}

function renderSettings(onChanged = vi.fn()): { onChanged: ReturnType<typeof vi.fn> } {
  render(
    <MemoryRouter>
      <NoteReviewSettings noteEntryId="note-1" onChanged={onChanged} />
    </MemoryRouter>
  );
  return { onChanged };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedHistory.mockResolvedValue({ events: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
});

describe("NoteReviewSettings list lifecycle (#660)", () => {
  it("offers a retry when the settings list cannot be loaded", async () => {
    mockedList.mockRejectedValueOnce(new Error("boom"));
    mockedList.mockResolvedValueOnce({ prompts: [] });
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("This note has no review prompts yet.")).toBeDefined();
  });

  it("renders every projected state and both reveal policies", async () => {
    resolveList(
      prompt({ promptId: "due", cardState: { state: "due" } }),
      prompt({
        promptId: "scheduled",
        cardState: { nextReviewAt: "2026-07-11T00:00:00.000Z", state: "scheduled" },
        reveal: {
          answerDoc: createTextDocument("a write-ahead log"),
          answerText: "a write-ahead log",
          kind: "legacy_custom"
        }
      }),
      prompt({ promptId: "paused", cardState: { state: "paused" } }),
      prompt({ promptId: "gone", cardState: { state: "not_in_review" } })
    );
    renderSettings();

    expect(await screen.findByText("Due now")).toBeDefined();
    expect(screen.getByText(/Next review ·/)).toBeDefined();
    expect(screen.getByText("Paused")).toBeDefined();
    expect(screen.getByText("Not in review")).toBeDefined();
    // Reveal policies: current_note carries no answer; legacy custom shows a read-only answer.
    expect(screen.getAllByText("Reveals the current note").length).toBe(3);
    expect(screen.getByText("Custom answer (read-only)")).toBeDefined();
    expect(screen.getByText("a write-ahead log")).toBeDefined();
    // A cardless prompt offers only re-adding — no restart/remove.
    const goneRow = screen.getByText("Not in review").closest("li") as HTMLElement;
    expect(within(goneRow).getByRole("button", { name: "Add to review" })).toBeDefined();
    expect(within(goneRow).queryByRole("button", { name: "Restart" })).toBeNull();
  });
});

describe("NoteReviewSettings question editing (#660)", () => {
  it("saves an edited question and refreshes just that row", async () => {
    resolveList(prompt());
    mockedEdit.mockResolvedValue(prompt({ questionText: "Define a WAL" }));
    const { onChanged } = renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Edit question" }));
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    await userEvent.type(input, "Define a WAL");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Define a WAL")).toBeDefined());
    expect(mockedEdit).toHaveBeenCalledWith("prompt-1", "Define a WAL");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("disables Save for a blank question and cancels back to the text", async () => {
    resolveList(prompt());
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Edit question" }));
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("What is a WAL?")).toBeDefined();
    expect(mockedEdit).not.toHaveBeenCalled();
  });
});

describe("NoteReviewSettings card transitions (#660)", () => {
  it("pauses an active card and reports the change", async () => {
    resolveList(
      prompt({ cardState: { state: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" } })
    );
    mockedPause.mockResolvedValue(prompt({ cardState: { state: "paused" } }));
    const { onChanged } = renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
    expect(mockedPause).toHaveBeenCalledWith("prompt-1");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("resumes a paused card", async () => {
    resolveList(prompt({ cardState: { state: "paused" } }));
    mockedResume.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Resume" }));

    await waitFor(() => expect(screen.getByText("Due now")).toBeDefined());
    expect(mockedResume).toHaveBeenCalledWith("prompt-1");
  });

  it("re-adds a removed prompt to review", async () => {
    resolveList(prompt({ cardState: { state: "not_in_review" } }));
    mockedAddBack.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));

    await waitFor(() => expect(screen.getByText("Due now")).toBeDefined());
    expect(mockedAddBack).toHaveBeenCalledWith("prompt-1");
  });

  it("confirms a restart and returns focus to the trigger", async () => {
    resolveList(
      prompt({ cardState: { state: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" } })
    );
    mockedRestart.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Restart" }));
    expect(screen.getByText(/Restart the schedule for/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Confirm restart" }));

    await waitFor(() => expect(screen.getByText("Due now")).toBeDefined());
    expect(mockedRestart).toHaveBeenCalledWith("prompt-1");
    expect((document.activeElement as HTMLElement).textContent).toBe("Restart");
  });

  it("cancels a restart confirmation and restores focus", async () => {
    resolveList(
      prompt({ cardState: { state: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" } })
    );
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel restart" }));

    expect(screen.queryByText(/Restart the schedule for/)).toBeNull();
    expect(mockedRestart).not.toHaveBeenCalled();
    expect((document.activeElement as HTMLElement).textContent).toBe("Restart");
  });

  it("confirms a removal, keeping the note and history", async () => {
    resolveList(prompt({ cardState: { state: "due" } }));
    mockedRemove.mockResolvedValue(prompt({ cardState: { state: "not_in_review" } }));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText(/The note and its history are kept/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Confirm remove" }));

    await waitFor(() => expect(screen.getByText("Not in review")).toBeDefined());
    expect(mockedRemove).toHaveBeenCalledWith("prompt-1");
  });

  it("cancels a removal confirmation", async () => {
    resolveList(prompt({ cardState: { state: "due" } }));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel remove" }));

    expect(screen.queryByText(/The note and its history are kept/)).toBeNull();
    expect(mockedRemove).not.toHaveBeenCalled();
    expect((document.activeElement as HTMLElement).textContent).toBe("Remove");
  });

  it("reloads the list and warns when a transition fails on stale state", async () => {
    mockedList.mockResolvedValueOnce({
      prompts: [
        prompt({ cardState: { state: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" } })
      ]
    });
    mockedList.mockResolvedValueOnce({ prompts: [prompt({ cardState: { state: "paused" } })] });
    mockedPause.mockRejectedValue(new Error("conflict"));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    expect(await screen.findByText(/That action could not be completed/)).toBeDefined();
    // The list was reloaded (now paused), never faking success.
    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it("leaves sibling prompts untouched when one row changes", async () => {
    resolveList(
      prompt({
        promptId: "p1",
        questionText: "Q1",
        cardState: { nextReviewAt: "2026-07-11T00:00:00.000Z", state: "scheduled" }
      }),
      prompt({ promptId: "p2", questionText: "Q2", cardState: { state: "paused" } })
    );
    mockedPause.mockResolvedValue(
      prompt({ promptId: "p1", questionText: "Q1", cardState: { state: "paused" } })
    );
    renderSettings();

    const q1Row = (await screen.findByText("Q1")).closest("li") as HTMLElement;
    await userEvent.click(within(q1Row).getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(within(q1Row).getByText("Paused")).toBeDefined());
    // The sibling row is passed through untouched by the row-level refresh.
    expect(screen.getByText("Q2")).toBeDefined();
  });

  it("guards against a double submit while a transition is in flight", async () => {
    resolveList(
      prompt({ cardState: { state: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" } })
    );
    const pending = deferred<NotePromptSettingsDto>();
    mockedPause.mockReturnValue(pending.promise);
    renderSettings();

    const pause = await screen.findByRole("button", { name: "Pause" });
    await userEvent.click(pause);
    expect(pause).toHaveProperty("disabled", true);

    pending.resolve(prompt({ cardState: { state: "paused" } }));
    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
    expect(mockedPause).toHaveBeenCalledTimes(1);
  });
});

describe("NoteReviewSettings history (#660)", () => {
  const ratingEvent = (
    id: string,
    rating: Extract<ReviewHistoryEventDto, { kind: "rating" }>["rating"]
  ): ReviewHistoryEventDto => ({
    id,
    kind: "rating",
    occurredAt: "2026-07-01T09:30:00.000Z",
    rating
  });

  it("loads, labels, and pages the append-only history", async () => {
    resolveList(prompt());
    const firstPage: ReviewHistoryPageDto = {
      events: [
        ratingEvent("e1", "again"),
        ratingEvent("e2", "hard"),
        { id: "e3", kind: "reset", occurredAt: "2026-06-30T09:30:00.000Z" }
      ],
      nextCursor: "cursor-1"
    };
    const secondPage: ReviewHistoryPageDto = {
      events: [ratingEvent("e4", "good"), ratingEvent("e5", "easy")],
      nextCursor: null
    };
    mockedHistory.mockResolvedValueOnce(firstPage);
    mockedHistory.mockResolvedValueOnce(secondPage);
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Review history" }));

    expect(await screen.findByText("Rated Again")).toBeDefined();
    expect(screen.getByText("Rated Hard")).toBeDefined();
    expect(screen.getByText("Schedule restarted")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Rated Good")).toBeDefined();
    expect(screen.getByText("Rated Easy")).toBeDefined();
    // The last page has no cursor, so "Load older" disappears.
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    expect(mockedHistory).toHaveBeenLastCalledWith("prompt-1", "cursor-1");
  });

  it("shows an empty state and hides history again", async () => {
    resolveList(prompt());
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Review history" }));
    expect(await screen.findByText("No review history yet.")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Hide review history" }));
    expect(screen.queryByText("No review history yet.")).toBeNull();
  });

  it("offers a retry when history cannot be loaded", async () => {
    resolveList(prompt());
    mockedHistory.mockRejectedValueOnce(new Error("boom"));
    mockedHistory.mockResolvedValueOnce({ events: [], nextCursor: null });
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Review history" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No review history yet.")).toBeDefined();
  });

  it("surfaces a failure while paging older history", async () => {
    resolveList(prompt());
    mockedHistory.mockResolvedValueOnce({ events: [ratingEvent("e1", "good")], nextCursor: "c1" });
    mockedHistory.mockRejectedValueOnce(new Error("boom"));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Review history" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load older" }));

    expect(await screen.findByText("Could not load the review history.")).toBeDefined();
  });
});
