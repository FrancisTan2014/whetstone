// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotePromptSettingsDto } from "@whetstone/contracts";
import { createTextDocument, documentText } from "@whetstone/document";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as NotesReviewApi from "../notesReview/notesReviewApi";

// Replace only the network calls; keep the real `SetNoteGradingTargetError` so the detail's `instanceof`
// mapping is exercised, not restubbed.
vi.mock("../notesReview/notesReviewApi", async () => {
  const actual = await vi.importActual<typeof NotesReviewApi>("../notesReview/notesReviewApi");
  return {
    ...actual,
    addNotePromptCardBack: vi.fn(),
    editNotePromptQuestion: vi.fn(),
    pauseNotePromptCard: vi.fn(),
    removeNotePromptCard: vi.fn(),
    restartNotePromptCard: vi.fn(),
    resumeNotePromptCard: vi.fn(),
    setNoteGradingTarget: vi.fn()
  };
});

// The shared editor stands in as a textarea keyed by its aria-label so the Question and Success check
// documents can be driven and read as plain text.
vi.mock("../../shared/editor/index.js", async () => {
  const React = await import("react");
  const { createTextDocument: make, documentText: read } = await import("@whetstone/document");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
    }) =>
      React.createElement("textarea", {
        "aria-label": ariaLabel,
        onChange: (event: { target: { value: string } }) => onChange(make(event.target.value)),
        value: read(document as never)
      })
  };
});

// The read-only note body renders as plain text so its presence as the Reference can be asserted directly.
vi.mock("../reader/PmDocument.js", async () => {
  const React = await import("react");
  const { documentText: read } = await import("@whetstone/document");
  return {
    PmDocument: ({ document }: { document: unknown }) =>
      React.createElement("div", { "data-testid": "pm" }, read(document as never))
  };
});

import { CardDetail } from "./CardDetail";

type CardDetailProps = Parameters<typeof CardDetail>[0];
import {
  addNotePromptCardBack,
  editNotePromptQuestion,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard,
  setNoteGradingTarget,
  SetNoteGradingTargetError
} from "../notesReview/notesReviewApi";

const mockedEdit = vi.mocked(editNotePromptQuestion);
const mockedPause = vi.mocked(pauseNotePromptCard);
const mockedResume = vi.mocked(resumeNotePromptCard);
const mockedRestart = vi.mocked(restartNotePromptCard);
const mockedRemove = vi.mocked(removeNotePromptCard);
const mockedAddBack = vi.mocked(addNotePromptCardBack);
const mockedSetTarget = vi.mocked(setNoteGradingTarget);

const noteBody = createTextDocument("The live note body.");

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
    noteBodyDoc?: CardDetailProps["noteBodyDoc"];
    onOpenHistory?: CardDetailProps["onOpenHistory"];
    onRefreshed?: CardDetailProps["onRefreshed"];
    onReload?: CardDetailProps["onReload"];
    prompt?: NotePromptSettingsDto;
  } = {}
) {
  const onOpenHistory = overrides.onOpenHistory ?? vi.fn<CardDetailProps["onOpenHistory"]>();
  const onRefreshed = overrides.onRefreshed ?? vi.fn<CardDetailProps["onRefreshed"]>();
  const onReload = overrides.onReload ?? vi.fn<CardDetailProps["onReload"]>();
  render(
    <CardDetail
      focusHistoryButton={overrides.focusHistoryButton ?? false}
      noteBodyDoc={overrides.noteBodyDoc === undefined ? noteBody : overrides.noteBodyDoc}
      onOpenHistory={onOpenHistory}
      onRefreshed={onRefreshed}
      onReload={onReload}
      prompt={overrides.prompt ?? prompt()}
      timeZone="UTC"
    />
  );
  return { onOpenHistory, onRefreshed, onReload };
}

async function openOverflow(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "More card actions" }));
  return screen.findByRole("menu");
}

beforeAll(() => {
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView"
  ]) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: () => false
    });
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

  it("edits a current-note question against the live note as read-only Reference", async () => {
    mockedEdit.mockResolvedValue(prompt({ questionText: "What is durability?" }));
    const onRefreshed = vi.fn<CardDetailProps["onRefreshed"]>();
    renderDetail({ onRefreshed });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    // The live note body is shown read-only so the learner sees exactly what the card grades against.
    expect(screen.getByText("The live note body.")).toBeDefined();
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    await userEvent.type(input, "What is durability?");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockedEdit).toHaveBeenCalled());
    const [id, doc] = mockedEdit.mock.calls[0]!;
    expect(id).toBe("prompt-1");
    expect(documentText(doc)).toBe("What is durability?");
    // No grading-target change, so only the question is sent.
    expect(mockedSetTarget).not.toHaveBeenCalled();
    expect(onRefreshed).toHaveBeenCalled();
  });

  it("blocks Save when the edited question is blank", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.clear(screen.getByLabelText("Question"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Write what should bring it to mind.")).toBeDefined();
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("closes the editor without any write when nothing changed", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("What is a WAL?")).toBeDefined();
    expect(mockedEdit).not.toHaveBeenCalled();
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("cancels an edit without calling the API", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.type(screen.getByLabelText("Question"), " more");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("What is a WAL?")).toBeDefined();
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("edits a legacy card's question through the answer-preserving editor only", async () => {
    mockedEdit.mockResolvedValue(
      prompt({
        questionText: "Define a WAL",
        reveal: {
          answerDoc: createTextDocument("a write-ahead log"),
          answerText: "a write-ahead log",
          kind: "legacy_custom"
        }
      })
    );
    renderDetail({
      prompt: prompt({
        reveal: {
          answerDoc: createTextDocument("a write-ahead log"),
          answerText: "a write-ahead log",
          kind: "legacy_custom"
        }
      })
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    // A legacy card exposes no grading-target editor — only the Question is editable.
    expect(screen.queryByRole("button", { name: "Add a specific success check" })).toBeNull();
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    await userEvent.type(input, "Define a WAL");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockedEdit).toHaveBeenCalled());
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("requires the Keep/Restart decision before writing a grading-target change on a scheduled card", async () => {
    mockedSetTarget.mockResolvedValue(prompt());
    const onRefreshed = vi.fn<CardDetailProps["onRefreshed"]>();
    renderDetail({ onRefreshed });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // The write is held until the learner declares Keep or Restart.
    expect(screen.getByText(/You changed how this card is graded/)).toBeDefined();
    expect(mockedSetTarget).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));
    await waitFor(() => expect(mockedSetTarget).toHaveBeenCalled());
    const [id, request] = mockedSetTarget.mock.calls[0]!;
    expect(id).toBe("prompt-1");
    expect(request.mode).toBe("keep");
    expect(request.target.kind).toBe("expected_response");
    expect(onRefreshed).toHaveBeenCalled();
  });

  it("restarts the schedule when the learner declares the trained capability changed", async () => {
    mockedSetTarget.mockResolvedValue(prompt());
    renderDetail();

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(mockedSetTarget).toHaveBeenCalled());
    expect(mockedSetTarget.mock.calls[0]![1].mode).toBe("restart");
  });

  it("cancels the Keep/Restart decision without writing", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const confirm = screen.getByText(/You changed how this card is graded/).closest("div")!;
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText(/You changed how this card is graded/)).toBeNull();
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("writes a grading-target change immediately for a cardless prompt, with no confirmation", async () => {
    mockedSetTarget.mockResolvedValue(prompt({ cardState: { state: "not_in_review" } }));
    renderDetail({ prompt: prompt({ cardState: { state: "not_in_review" } }) });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // No schedule to protect, so the change persists directly with the schedule left alone.
    await waitFor(() => expect(mockedSetTarget).toHaveBeenCalled());
    expect(screen.queryByText(/You changed how this card is graded/)).toBeNull();
    expect(mockedSetTarget.mock.calls[0]![1].mode).toBe("keep");
  });

  it("applies both a grading-target change and a question edit, keeping the last refreshed row", async () => {
    mockedSetTarget.mockResolvedValue(prompt({ questionText: "stale" }));
    mockedEdit.mockResolvedValue(prompt({ questionText: "final question" }));
    const onRefreshed = vi.fn<CardDetailProps["onRefreshed"]>();
    renderDetail({ onRefreshed });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    const input = screen.getByLabelText("Question");
    await userEvent.clear(input);
    await userEvent.type(input, "final question");
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));

    await waitFor(() => expect(mockedEdit).toHaveBeenCalled());
    expect(mockedSetTarget).toHaveBeenCalled();
    // The question send runs after the target send, so its row is the one handed up.
    expect(onRefreshed).toHaveBeenCalledWith(expect.objectContaining({ questionText: "final question" }));
  });

  it("reports a named grading-target failure and reloads the list", async () => {
    mockedSetTarget.mockRejectedValue(new SetNoteGradingTargetError("legacy_read_only"));
    const onReload = vi.fn<CardDetailProps["onReload"]>();
    renderDetail({ onReload });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));

    expect(
      await screen.findByText(
        "This card keeps its original answer and cannot change its grading target."
      )
    ).toBeDefined();
    expect(onReload).toHaveBeenCalled();
  });

  it("maps a non-typed persist rejection to the generic failure and reloads", async () => {
    mockedSetTarget.mockRejectedValue(new Error("boom"));
    const onReload = vi.fn<CardDetailProps["onReload"]>();
    renderDetail({ onReload });

    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByLabelText("Success check"), "Must name the log.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));

    expect(
      await screen.findByText(/That action could not be completed\. The list was refreshed/)
    ).toBeDefined();
    expect(onReload).toHaveBeenCalled();
  });

  it("shows the note-has-no-body message in the Reference for a bodyless prompt", async () => {
    renderDetail({ noteBodyDoc: null });
    await userEvent.click(screen.getByRole("button", { name: "Edit question" }));
    expect(screen.getByText("This note has no body to reveal.")).toBeDefined();
  });

  it("pauses a due card", async () => {
    mockedPause.mockResolvedValue(prompt({ cardState: { state: "paused" } }));
    const onRefreshed = vi.fn<CardDetailProps["onRefreshed"]>();
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

  it("starts reviewing a cardless prompt, and offers no overflow while it is out of review", async () => {
    mockedAddBack.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderDetail({ prompt: prompt({ cardState: { state: "not_in_review" } }) });
    // A card that is not in review exposes no destructive overflow.
    expect(screen.queryByRole("button", { name: "More card actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start reviewing" }));
    await waitFor(() => expect(mockedAddBack).toHaveBeenCalledWith("prompt-1"));
  });

  it("opens the per-card history", async () => {
    const onOpenHistory = vi.fn<CardDetailProps["onOpenHistory"]>();
    renderDetail({ onOpenHistory });
    await userEvent.click(screen.getByRole("button", { name: "Review history" }));
    expect(onOpenHistory).toHaveBeenCalled();
  });

  it("restarts the schedule from the overflow and returns focus to the trigger", async () => {
    mockedRestart.mockResolvedValue(prompt({ cardState: { state: "due" } }));
    renderDetail({
      prompt: prompt({
        cardState: { nextReviewAt: "2026-07-11T00:00:00.000Z", state: "scheduled" }
      })
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
      prompt: prompt({
        cardState: { nextReviewAt: "2026-07-11T00:00:00.000Z", state: "scheduled" }
      })
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
    const onRefreshed = vi.fn<CardDetailProps["onRefreshed"]>();
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
    const onReload = vi.fn<CardDetailProps["onReload"]>();
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
