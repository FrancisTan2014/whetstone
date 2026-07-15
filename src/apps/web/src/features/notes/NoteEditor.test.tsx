// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  createNote: vi.fn(),
  updateNote: vi.fn()
}));

// The shared rich editor (#570) is exercised in its own suite; here it stands in as a plain textarea so
// the note editor's behaviour (which document is saved, blank rejection) is asserted without driving
// Tiptap in jsdom. Ctrl/Cmd+S forwards to the editor's `onSave` so the blank-save path is reachable.
vi.mock("../../shared/editor/index.js", async () => {
  const { createTextDocument, documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange,
      onSave
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
      onSave?: () => void;
    }) => {
      // Model the real editor's contract: `document` is authoritative, so the surface re-syncs to it
      // whenever the prop's content changes (RichContentEditor.tsx resets via `setContent`). A stable
      // initial document therefore preserves typed input; a fresh document identity per render wipes it.
      const [value, setValue] = React.useState(() => documentText(document as never));
      React.useEffect(() => {
        const incoming = documentText(document as never);
        setValue((current) => (current === incoming ? current : incoming));
      }, [document]);
      return React.createElement("textarea", {
        "aria-label": ariaLabel,
        onChange: (event: { target: { value: string } }) => {
          setValue(event.target.value);
          onChange(createTextDocument(event.target.value));
        },
        onKeyDown: (event: {
          ctrlKey: boolean;
          key: string;
          metaKey: boolean;
          preventDefault: () => void;
        }) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") {
            event.preventDefault();
            onSave?.();
          }
        },
        value
      });
    }
  };
});

import { createNote, updateNote } from "./notesApi";
import { NoteEditor, type NoteEditorTarget } from "./NoteEditor";
import type { NoteDraft } from "./noteCapture";
import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument, documentText } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

const mockedCreateNote = vi.mocked(createNote);
const mockedUpdateNote = vi.mocked(updateNote);

const subBlockDraft: NoteDraft = {
  blockEntryId: "block-1",
  contextSnapshot: "The quick brown fox.",
  endOffset: 19,
  selectedText: "fox",
  startOffset: 16
};

const subBlockAnchor = {
  blockEntryId: "block-1",
  contextSnapshot: "The quick brown fox.",
  endBlockEntryId: "block-1",
  endOffset: 19,
  selectedTextSnapshot: "fox",
  startOffset: 16
};

const existingNote: AnchoredNoteDto = {
  anchor: {
    blockEntryId: toEntryId("block-1"),
    contextSnapshot: "The quick brown fox.",
    endBlockEntryId: toEntryId("block-1"),
    endOffset: 19,
    selectedTextSnapshot: "fox",
    startOffset: 16
  },
  blockEntryId: toEntryId("block-1"),
  bodyDoc: createTextDocument("a sly animal"),
  bodyText: "a sly animal",
  captureSource: "reader",
  createdAt: "2024-01-01T00:00:00.000Z",
  entryId: toEntryId("note-7"),
  kind: "note",
  occurredAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z"
};

const savedNote = { entryId: toEntryId("note-1"), kind: "note" } as AnchoredNoteDto;

function noteBody(): HTMLTextAreaElement {
  return screen.getByLabelText("Note body") as HTMLTextAreaElement;
}

function renderEditor(
  overrides: {
    onClose?: () => void;
    onSaved?: (note: AnchoredNoteDto) => void;
    target?: NoteEditorTarget;
  } = {}
): {
  onClose: () => void;
  onSaved: (note: AnchoredNoteDto) => void;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onClose = overrides.onClose ?? vi.fn();
  const onSaved = overrides.onSaved ?? vi.fn();
  const user = userEvent.setup();
  render(
    <NoteEditor
      onClose={onClose}
      onSaved={onSaved}
      target={overrides.target ?? { draft: subBlockDraft, kind: "create" }}
      workEntryId="work-1"
    />
  );

  return { onClose, onSaved, user };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("NoteEditor create mode", () => {
  it("opens straight to one focused body with the source shown as read-only context", () => {
    renderEditor();

    expect(screen.getByRole("heading", { name: "New note" })).toBeDefined();
    expect(screen.getByText("Selected: fox")).toBeDefined();
    expect(noteBody().tagName).toBe("TEXTAREA");
    // No template choice is offered.
    expect(screen.queryByRole("button", { name: "Vocabulary" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Template" })).toBeNull();
    // Save is disabled while the body is blank.
    expect((screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("saves the authored document with the capture anchor and no client plaintext", async () => {
    mockedCreateNote.mockResolvedValue(savedNote);
    const { onSaved, user } = renderEditor();

    await user.type(noteBody(), "to outwit");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(mockedCreateNote).toHaveBeenCalledWith("work-1", {
        anchor: subBlockAnchor,
        bodyDoc: createTextDocument("to outwit")
      })
    );
    expect(onSaved).toHaveBeenCalledWith(savedNote);
  });

  it("keeps the typed body across the re-renders that typing triggers", async () => {
    // Regression (#619): each keystroke re-renders NoteEditor. The editor's initial document must stay
    // stable for the target's lifetime, or the authoritative-document reset wipes the text mid-typing.
    mockedCreateNote.mockResolvedValue(savedNote);
    const { user } = renderEditor();

    await user.type(noteBody(), "a whole sentence of authored content");

    expect(noteBody().value).toBe("a whole sentence of authored content");

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(mockedCreateNote).toHaveBeenCalledTimes(1));
    const request = mockedCreateNote.mock.calls[0]?.[1];
    expect(documentText(request?.bodyDoc as never)).toBe("a whole sentence of authored content");
  });

  it("announces a blank save attempt and does not call the API", async () => {
    const { user } = renderEditor();

    await user.click(noteBody());
    await user.keyboard("{Control>}s{/Control}");

    expect(screen.getByRole("alert").textContent).toBe("Write something before saving the note.");
    expect(mockedCreateNote).not.toHaveBeenCalled();
  });

  it("shows an error when saving fails", async () => {
    mockedCreateNote.mockRejectedValue(new Error("boom"));
    const { onSaved, user } = renderEditor();

    await user.type(noteBody(), "to outwit");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Could not save the note. Please try again.")).toBeDefined();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("recovers when a retried save succeeds after a failure", async () => {
    mockedCreateNote.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(savedNote);
    const { onSaved, user } = renderEditor();

    await user.type(noteBody(), "to outwit");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Could not save the note. Please try again.")).toBeDefined();
    expect(onSaved).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(savedNote);
    });
    expect(screen.queryByText("Could not save the note. Please try again.")).toBeNull();
    expect(mockedCreateNote).toHaveBeenCalledTimes(2);
  });

  it("disables the save button while the note is being saved", async () => {
    let resolveSave: (note: AnchoredNoteDto) => void = () => {};
    mockedCreateNote.mockImplementation(
      () =>
        new Promise<AnchoredNoteDto>((resolve) => {
          resolveSave = resolve;
        })
    );
    const { user } = renderEditor();

    await user.type(noteBody(), "to outwit");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    const saveButton = screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveButton.getAttribute("aria-busy")).toBe("true");
    });
    expect(saveButton.disabled).toBe(true);

    resolveSave(savedNote);
    await waitFor(() => {
      expect(mockedCreateNote).toHaveBeenCalledTimes(1);
    });
  });

  it("closes when cancelled", async () => {
    const { onClose, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
  });
});

describe("NoteEditor edit mode", () => {
  it("prefills the canonical body and the anchor snippet", () => {
    renderEditor({ target: { kind: "edit", note: existingNote } });

    expect(screen.getByRole("heading", { name: "Edit note" })).toBeDefined();
    expect(screen.getByText("Selected: fox")).toBeDefined();
    expect(noteBody().value).toBe("a sly animal");
  });

  it("saves the replaced document through the update endpoint", async () => {
    const updated = { ...existingNote, bodyText: "a cunning animal" } as AnchoredNoteDto;
    mockedUpdateNote.mockResolvedValue(updated);
    const { onSaved, user } = renderEditor({ target: { kind: "edit", note: existingNote } });

    const field = noteBody();
    await user.clear(field);
    await user.type(field, "a cunning animal");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(mockedUpdateNote).toHaveBeenCalledWith("work-1", "note-7", {
        bodyDoc: createTextDocument("a cunning animal")
      })
    );
    expect(onSaved).toHaveBeenCalledWith(updated);
    expect(mockedCreateNote).not.toHaveBeenCalled();
  });

  it("shows an error when the update fails", async () => {
    mockedUpdateNote.mockRejectedValue(new Error("boom"));
    const { user } = renderEditor({ target: { kind: "edit", note: existingNote } });

    const field = noteBody();
    await user.clear(field);
    await user.type(field, "changed");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Could not save the note. Please try again.")).toBeDefined();
  });
});
