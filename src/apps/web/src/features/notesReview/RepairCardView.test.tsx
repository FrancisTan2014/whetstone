// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  NotePromptSettingsDto,
  NotePromptSettingsListDto,
  NoteRevealDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as NotesReviewApi from "./notesReviewApi";

// Replace only the network calls; keep the real `SetNoteGradingTargetError` so the view's `instanceof`
// mapping is exercised, not restubbed.
vi.mock("./notesReviewApi", async () => {
  const actual = await vi.importActual<typeof NotesReviewApi>("./notesReviewApi");
  return {
    ...actual,
    editNotePromptQuestion: vi.fn(),
    fetchNotePromptSettings: vi.fn(),
    fetchNoteReveal: vi.fn(),
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
      editable = true,
      onChange
    }: {
      ariaLabel?: string;
      document: unknown;
      editable?: boolean;
      onChange: (document: unknown) => void;
    }) =>
      React.createElement("textarea", {
        "aria-label": ariaLabel,
        disabled: !editable,
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

import { RepairCardView } from "./RepairCardView";
import {
  EditNotePromptQuestionError,
  editNotePromptQuestion,
  fetchNotePromptSettings,
  fetchNoteReveal,
  setNoteGradingTarget,
  SetNoteGradingTargetError
} from "./notesReviewApi";

const mockedSettings = vi.mocked(fetchNotePromptSettings);
const mockedReveal = vi.mocked(fetchNoteReveal);
const mockedEdit = vi.mocked(editNotePromptQuestion);
const mockedSetTarget = vi.mocked(setNoteGradingTarget);

function promptRow(overrides: Partial<NotePromptSettingsDto> = {}): NotePromptSettingsDto {
  return {
    cardState: { state: "due" },
    promptId: "prompt-1",
    revision: 0,
    questionDoc: createTextDocument("What is a WAL?"),
    questionText: "What is a WAL?",
    reveal: { kind: "current_note" },
    ...overrides
  };
}

function settingsList(prompts: ReadonlyArray<NotePromptSettingsDto>): NotePromptSettingsListDto {
  return { prompts: [...prompts] };
}

const currentReveal: NoteRevealDto = {
  bodyDoc: createTextDocument("The live note body."),
  bodyText: "The live note body.",
  kind: "current_note"
};

function renderView(overrides: Partial<Parameters<typeof RepairCardView>[0]> = {}) {
  const onCancel = overrides.onCancel ?? vi.fn();
  const onRepaired = overrides.onRepaired ?? vi.fn();
  const onOpenNote = overrides.onOpenNote ?? vi.fn();
  const view = render(
    <RepairCardView
      noteId={overrides.noteId ?? "note-1"}
      onCancel={onCancel}
      onOpenNote={onOpenNote}
      onRepaired={onRepaired}
      promptId={overrides.promptId ?? "prompt-1"}
    />
  );
  return { onCancel, onOpenNote, onRepaired, unmount: view.unmount };
}

async function loaded(): Promise<void> {
  await screen.findByRole("heading", { name: "Fix this card" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockResolvedValue(settingsList([promptRow()]));
  mockedReveal.mockResolvedValue(currentReveal);
});

afterEach(() => {
  cleanup();
});

describe("RepairCardView", () => {
  it("shows a loading indicator until the card resolves", () => {
    mockedSettings.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(screen.getByText("Opening this card to fix…")).toBeTruthy();
  });

  it("loads the question, the note as read-only Reference, and Open note", async () => {
    renderView();
    await loaded();

    expect(screen.getByRole("textbox", { name: "Question" }).textContent ?? "").toContain(
      "What is a WAL?"
    );
    expect(screen.getByText("The live note body.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open note" })).toBeTruthy();
    // A single-card note carries no shared-edit warning.
    expect(screen.queryByText(/review cards\./)).toBeNull();
  });

  it("moves focus to the repair heading once the card is ready", async () => {
    renderView();
    const heading = await screen.findByRole("heading", { name: "Fix this card" });
    // Focus lands only after the async load resolves (the loading placeholder has no heading to focus).
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("warns that editing the note affects every card when the note has siblings", async () => {
    mockedSettings.mockResolvedValue(
      settingsList([promptRow(), promptRow({ promptId: "prompt-2" })])
    );
    renderView();
    await loaded();

    expect(screen.getByText(/This note has 2 review cards\./)).toBeTruthy();
  });

  it("Open note asks the session to open the shared note", async () => {
    const { onOpenNote } = renderView({ noteId: "note-42" });
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Open note" }));
    expect(onOpenNote).toHaveBeenCalledWith("note-42");
  });

  it("saving a question-only edit writes only the question and keeps the schedule", async () => {
    mockedEdit.mockResolvedValue(promptRow({ questionText: "What is a write-ahead log?" }));
    const { onRepaired } = renderView();
    await loaded();

    const question = screen.getByRole("textbox", { name: "Question" });
    await userEvent.clear(question);
    await userEvent.type(question, "What is a write-ahead log?");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onRepaired).toHaveBeenCalledTimes(1));
    expect(mockedEdit).toHaveBeenCalledWith("prompt-1", {
      expectedRevision: 0,
      questionDoc: createTextDocument("What is a write-ahead log?")
    });
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("saving with nothing changed cancels without any write", async () => {
    const { onCancel } = renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockedEdit).not.toHaveBeenCalled();
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("Cancel returns to review without writing", async () => {
    const { onCancel } = renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("Escape cancels when idle, and any other key does nothing", async () => {
    const { onCancel } = renderView();
    await loaded();

    screen.getByRole("textbox", { name: "Question" }).focus();
    await userEvent.keyboard("a");
    expect(onCancel).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape does nothing while a save is in flight", async () => {
    mockedEdit.mockReturnValue(new Promise(() => {}));
    const { onCancel, onRepaired } = renderView();
    await loaded();

    const question = screen.getByRole("textbox", { name: "Question" });
    await userEvent.type(question, " revised");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await userEvent.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(onRepaired).not.toHaveBeenCalled();
  });

  it("changing the grading target on a scheduled card asks Keep or Restart, and Keep saves keep", async () => {
    mockedSetTarget.mockResolvedValue(promptRow());
    const { onRepaired } = renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Success check" }),
      "Names durability."
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));
    await waitFor(() => expect(onRepaired).toHaveBeenCalledTimes(1));
    expect(mockedSetTarget).toHaveBeenCalledWith("prompt-1", {
      expectedRevision: 0,
      mode: "keep",
      target: {
        kind: "expected_response",
        successCheckDoc: createTextDocument("Names durability.")
      }
    });
    // The question was untouched, so no question write is sent alongside the target change.
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("Restart resets the schedule for a grading-target change", async () => {
    mockedSetTarget.mockResolvedValue(promptRow());
    renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Success check" }),
      "Names durability."
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() =>
      expect(mockedSetTarget).toHaveBeenCalledWith("prompt-1", {
        expectedRevision: 0,
        mode: "restart",
        target: {
          kind: "expected_response",
          successCheckDoc: createTextDocument("Names durability.")
        }
      })
    );
  });

  it("cancelling the Keep/Restart prompt keeps editing without writing", async () => {
    renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Success check" }),
      "Names durability."
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const group = screen.getByRole("group");
    await userEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Keep schedule" })).toBeNull();
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("freezes every draft while Keep/Restart is pending so the target snapshot cannot go stale", async () => {
    mockedSetTarget.mockResolvedValue(promptRow({ revision: 1 }));
    renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    const successCheck = screen.getByRole("textbox", { name: "Success check" });
    await userEvent.type(successCheck, "Names durability.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      (screen.getByRole("textbox", { name: "Question" }) as HTMLTextAreaElement).disabled
    ).toBe(true);
    expect((successCheck as HTMLTextAreaElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Remove success check" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(successCheck, " Newer visible draft.");
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));

    await waitFor(() => expect(mockedSetTarget).toHaveBeenCalledTimes(1));
    expect(mockedSetTarget).toHaveBeenCalledWith("prompt-1", {
      expectedRevision: 0,
      mode: "keep",
      target: {
        kind: "expected_response",
        successCheckDoc: createTextDocument("Names durability.")
      }
    });
  });

  it("a target change plus a question edit sends both writes", async () => {
    mockedSetTarget.mockResolvedValue(promptRow({ revision: 1 }));
    mockedEdit.mockResolvedValue(promptRow({ questionText: "Define a WAL.", revision: 2 }));
    const { onRepaired } = renderView();
    await loaded();

    const question = screen.getByRole("textbox", { name: "Question" });
    await userEvent.clear(question);
    await userEvent.type(question, "Define a WAL.");
    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Success check" }), "Ordering.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));

    await waitFor(() => expect(onRepaired).toHaveBeenCalledTimes(1));
    expect(mockedSetTarget).toHaveBeenCalledTimes(1);
    expect(mockedEdit).toHaveBeenCalledWith("prompt-1", {
      expectedRevision: 1,
      questionDoc: createTextDocument("Define a WAL.")
    });
  });

  it("a cardless prompt saves a target change immediately, without Keep/Restart", async () => {
    mockedSettings.mockResolvedValue(
      settingsList([promptRow({ cardState: { state: "not_in_review" } })])
    );
    mockedSetTarget.mockResolvedValue(promptRow({ cardState: { state: "not_in_review" } }));
    const { onRepaired } = renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Success check" }), "Ordering.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onRepaired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Keep schedule" })).toBeNull();
    expect(mockedSetTarget).toHaveBeenCalledWith("prompt-1", {
      expectedRevision: 0,
      mode: "keep",
      target: { kind: "expected_response", successCheckDoc: createTextDocument("Ordering.") }
    });
  });

  it("rejects a blank question", async () => {
    const { onCancel } = renderView();
    await loaded();

    await userEvent.clear(screen.getByRole("textbox", { name: "Question" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Write what should bring it to mind.")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("rejects a blank success check", async () => {
    renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Write the success check, or remove it.")).toBeTruthy();
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("keeps the target draft, names a stale-write conflict, and offers Reload card", async () => {
    mockedSetTarget.mockRejectedValue(new SetNoteGradingTargetError("conflict"));
    renderView();
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Success check" }), "Ordering.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep schedule" }));

    expect(
      await screen.findByText(
        "This card changed elsewhere. Your draft is still here — reload the card before saving."
      )
    ).toBeTruthy();
    // The draft survives the failure.
    expect(screen.getByRole("textbox", { name: "Success check" }).textContent ?? "").toContain(
      "Ordering."
    );

    mockedSettings.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Reload card" }));
    await waitFor(() => expect(mockedSettings).toHaveBeenCalledTimes(1));
  });

  it("shows the generic retry message when a question edit fails", async () => {
    mockedEdit.mockRejectedValue(new Error("network"));
    renderView();
    await loaded();

    const question = screen.getByRole("textbox", { name: "Question" });
    await userEvent.type(question, " revised");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "That action could not be completed. The list was refreshed — please try again."
      )
    ).toBeTruthy();
  });

  it("keeps the Question draft and names a stale-write conflict until Reload card", async () => {
    mockedEdit.mockRejectedValue(new EditNotePromptQuestionError("conflict"));
    renderView();
    await loaded();

    const question = screen.getByRole("textbox", { name: "Question" });
    await userEvent.type(question, " revised");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "This card changed elsewhere. Your draft is still here — reload the card before saving."
      )
    ).toBeTruthy();
    expect((question as HTMLTextAreaElement).value).toBe("What is a WAL? revised");
    expect(screen.getByRole("button", { name: "Reload card" })).toBeTruthy();
  });

  it("seeds an expected-response prompt with its success check open and the note as Reference", async () => {
    mockedSettings.mockResolvedValue(
      settingsList([
        promptRow({
          reveal: {
            kind: "expected_response",
            successCheckDoc: createTextDocument("Names durability."),
            successCheckText: "Names durability."
          }
        })
      ])
    );
    mockedReveal.mockResolvedValue({
      kind: "expected_response",
      referenceDoc: createTextDocument("The reference body."),
      referenceText: "The reference body.",
      successCheckDoc: createTextDocument("Names durability."),
      successCheckText: "Names durability."
    });
    const { onCancel } = renderView();
    await loaded();

    expect(screen.getByRole("textbox", { name: "Success check" }).textContent ?? "").toContain(
      "Names durability."
    );
    expect(screen.getByText("The reference body.")).toBeTruthy();

    // Saving without touching the seeded target is a no-op cancel — the round-trip is not a change.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockedSetTarget).not.toHaveBeenCalled();
  });

  it("edits the question only for a legacy custom prompt (no Reference or success check)", async () => {
    mockedSettings.mockResolvedValue(
      settingsList([
        promptRow({
          reveal: {
            answerDoc: createTextDocument("The preserved answer."),
            answerText: "The preserved answer.",
            kind: "legacy_custom"
          }
        })
      ])
    );
    mockedReveal.mockResolvedValue({
      answerDoc: createTextDocument("The preserved answer."),
      answerText: "The preserved answer.",
      kind: "legacy_custom"
    });
    mockedEdit.mockResolvedValue(promptRow());
    const { onRepaired } = renderView();
    await loaded();

    expect(screen.queryByRole("button", { name: "Add a specific success check" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open note" })).toBeNull();

    const question = screen.getByRole("textbox", { name: "Question" });
    await userEvent.type(question, " (rich)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onRepaired).toHaveBeenCalledTimes(1));
    expect(mockedEdit).toHaveBeenCalledTimes(1);
  });

  it("shows an unavailable message when the prompt is missing from the note's settings", async () => {
    mockedSettings.mockResolvedValue(settingsList([promptRow({ promptId: "other" })]));
    const { onCancel } = renderView();

    expect(await screen.findByText("This card is no longer available.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back to review" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows an unavailable message when the initial load fails", async () => {
    mockedSettings.mockRejectedValue(new Error("boom"));
    renderView();

    expect(await screen.findByText("This card is no longer available.")).toBeTruthy();
  });

  it("ignores a load that resolves after the view has unmounted", async () => {
    let resolve: (value: NotePromptSettingsListDto) => void = () => {};
    mockedSettings.mockReturnValue(
      new Promise<NotePromptSettingsListDto>((resolveSettings) => {
        resolve = resolveSettings;
      })
    );
    const { unmount } = renderView();
    unmount();

    resolve(settingsList([promptRow()]));
    await new Promise((settle) => setTimeout(settle, 0));
    // No throw and no "Fix this card" heading — the resolved load was discarded.
    expect(screen.queryByRole("heading", { name: "Fix this card" })).toBeNull();
  });

  it("ignores a load that rejects after the view has unmounted", async () => {
    let reject: (reason: Error) => void = () => {};
    mockedSettings.mockReturnValue(
      new Promise<NotePromptSettingsListDto>((_resolve, rejectSettings) => {
        reject = rejectSettings;
      })
    );
    const { unmount } = renderView();
    unmount();

    reject(new Error("boom"));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(screen.queryByText("This card is no longer available.")).toBeNull();
  });

  it("rejects a blank question on a legacy custom prompt", async () => {
    mockedSettings.mockResolvedValue(
      settingsList([
        promptRow({
          reveal: {
            answerDoc: createTextDocument("The preserved answer."),
            answerText: "The preserved answer.",
            kind: "legacy_custom"
          }
        })
      ])
    );
    mockedReveal.mockResolvedValue({
      answerDoc: createTextDocument("The preserved answer."),
      answerText: "The preserved answer.",
      kind: "legacy_custom"
    });
    renderView();
    await loaded();

    await userEvent.clear(screen.getByRole("textbox", { name: "Question" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Write what should bring it to mind.")).toBeTruthy();
    expect(mockedEdit).not.toHaveBeenCalled();
  });
});
