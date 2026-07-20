// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotePromptSettingsDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  addNotePromptCardBack: vi.fn(),
  editNotePromptQuestion: vi.fn(),
  pauseNotePromptCard: vi.fn(),
  removeNotePromptCard: vi.fn(),
  restartNotePromptCard: vi.fn(),
  resumeNotePromptCard: vi.fn()
}));

import { CardDetail } from "./CardDetail";
import {
  addNotePromptCardBack,
  editNotePromptQuestion,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard
} from "../notesReview/notesReviewApi";

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

function renderDetail(
  overrides: {
    focusHistoryButton?: boolean;
    onOpenHistory?: ReturnType<typeof vi.fn>;
    onRefreshed?: ReturnType<typeof vi.fn>;
    onReload?: ReturnType<typeof vi.fn>;
    prompt?: NotePromptSettingsDto;
  } = {}
) {
  const onOpenHistory = overrides.onOpenHistory ?? vi.fn();
  const onRefreshed = overrides.onRefreshed ?? vi.fn();
  const onReload = overrides.onReload ?? vi.fn();
  render(
    <CardDetail
      focusHistoryButton={overrides.focusHistoryButton ?? false}
      onOpenHistory={onOpenHistory}
      onRefreshed={onRefreshed}
      onReload={onReload}
      prompt={overrides.prompt ?? prompt()}
      timeZone="UTC"
    />
  );
  return { onOpenHistory, onRefreshed: onRefreshed, onReload };
}

async function openOverflow(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "More card actions" }));
  return screen.findByRole("menu");
}

beforeAll(() => {
  for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture", "scrollIntoView"]) {
    Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: () => false });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("CardDetail", () => {
  it("shows the question, a current-note reveal, and the due state", () => {
    renderDetail();
    expect(screen.getByText("What is a WAL?")).toBeDefined();
    expect(screen.getByText("Reveals the current note")).toBeDefined();
    expect(screen.getByText("Due now")).toBeDefined();
  });

  it("shows a success-check reveal with its text", () => {
    renderDetail({
      prompt: prompt({
        reveal: {
          kind: "expected_response",
          successCheckDoc: createTextDocument("names durability and ordering"),
          successCheckText: "names durability and ordering"
        }
      })
    });
    expect(screen.getByText("Success check")).toBeDefined();
    expect(screen.getByText("names durability and ordering")).toBeDefined();
  });

  it("shows a preserved legacy reveal read-only", () => {
    renderDetail({
      prompt: prompt({
        reveal: {
          answerDoc: createTextDocument("a write-ahead log"),
          answerText: "a write-ahead log",
          kind: "legacy_custom"
        }
      })
    });
    expect(screen.getByText("Custom answer (read-only)")).toBeDefined();
    expect(screen.getByText("a write-ahead log")).toBeDefined();
  });

  it("edits the question, trimming and handing the refreshed card up", async () => {
    mockedEdit.mockResolvedValue(prompt({ questionText: "What is durability?" }));
    const onRefreshed = vi.fn();
    renderDetail({ onRefreshed });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    await userEvent.type(input, "  What is durability?  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedEdit).toHaveBeenCalledWith("prompt-1", "What is durability?")
    );
    expect(onRefreshed).toHaveBeenCalled();
  });

  it("disables Save while the edited question is blank", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("cancels an edit without calling the API", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.type(screen.getByLabelText("Question"), " more");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("What is a WAL?")).toBeDefined();
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("pauses a due card", async () => {
    mockedPause.mockResolvedValue(prompt({ cardState: { state: "paused" } }));
    const onRefreshed = vi.fn();
    renderDetail({ onRefreshed });
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mockedPause).toHaveBeenCalledWith("prompt-1"));
    expect(onRefreshed).toHaveBeenCalled();
  });

  it("resumes a paused card", async () => {
    mockedResume.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderDetail({ prompt: prompt({ cardState: { state: "paused" } }) });
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mockedResume).toHaveBeenCalledWith("prompt-1"));
  });

  it("re-adds a removed card, and offers no overflow while it is out of review", async () => {
    mockedAddBack.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderDetail({ prompt: prompt({ cardState: { state: "not_in_review" } }) });
    // A card that is not in review exposes no destructive overflow.
    expect(screen.queryByRole("button", { name: "More card actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
    await waitFor(() => expect(mockedAddBack).toHaveBeenCalledWith("prompt-1"));
  });

  it("opens the per-card history", async () => {
    const onOpenHistory = vi.fn();
    renderDetail({ onOpenHistory });
    await userEvent.click(screen.getByRole("button", { name: "Review history" }));
    expect(onOpenHistory).toHaveBeenCalled();
  });

  it("restarts the schedule from the overflow and returns focus to the trigger", async () => {
    mockedRestart.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderDetail({
      prompt: prompt({ cardState: { nextReviewAt: "2026-07-11T00:00:00.000Z", state: "scheduled" } })
    });

    const menu = await openOverflow();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Restart schedule" }));
    expect(screen.getByText(/Restart the schedule for/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Confirm restart" }));

    await waitFor(() => expect(mockedRestart).toHaveBeenCalledWith("prompt-1"));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("More card actions")
    );
  });

  it("cancels a restart without calling the API and restores focus", async () => {
    renderDetail({
      prompt: prompt({ cardState: { nextReviewAt: "2026-07-11T00:00:00.000Z", state: "scheduled" } })
    });
    const menu = await openOverflow();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Restart schedule" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel restart" }));

    expect(screen.queryByText(/Restart the schedule for/)).toBeNull();
    expect(mockedRestart).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("More card actions");
  });

  it("removes the card from review, keeping the note and history", async () => {
    mockedRemove.mockResolvedValue(prompt({ cardState: { state: "not_in_review" } }));
    const onRefreshed = vi.fn();
    renderDetail({ onRefreshed });
    const menu = await openOverflow();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from review" }));
    expect(screen.getByText(/The note and its history are kept/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Confirm remove" }));

    await waitFor(() => expect(mockedRemove).toHaveBeenCalledWith("prompt-1"));
    expect(onRefreshed).toHaveBeenCalled();
  });

  it("cancels a removal without calling the API", async () => {
    renderDetail();
    const menu = await openOverflow();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from review" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel remove" }));

    expect(screen.queryByText(/The note and its history are kept/)).toBeNull();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it("reports a failed action and reloads the list to correct a stale row", async () => {
    mockedPause.mockRejectedValueOnce(new Error("offline"));
    const onReload = vi.fn();
    renderDetail({ onReload });
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(onReload).toHaveBeenCalled();
  });

  it("returns focus to Review history when arriving via Back from History", async () => {
    renderDetail({ focusHistoryButton: true });
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).textContent).toBe("Review history")
    );
  });
});
