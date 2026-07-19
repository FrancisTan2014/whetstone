// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  createStandaloneNote: vi.fn(),
  deleteOwnedNote: vi.fn(),
  updateOwnedNote: vi.fn()
}));

// The Review section has its own suite; here it stands in as a marker so the editor's own behaviour is
// asserted in isolation and the section only appears in edit mode.
vi.mock("./OwnedNoteReviewSection", async () => {
  const React = await import("react");
  return {
    OwnedNoteReviewSection: (props: { note: { entryId: string }; onEnrolled?: () => void }) =>
      React.createElement(
        "div",
        { "data-note": props.note.entryId, "data-testid": "owned-review-section" },
        React.createElement(
          "button",
          { onClick: () => props.onEnrolled?.(), type: "button" },
          "stub-enroll"
        )
      )
  };
});

vi.mock("../../shared/editor/index.js", async () => {
  const { createTextDocument, documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange,
      onSave,
      presentation
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
      onSave?: () => void;
      presentation?: string;
    }) => {
      const [value, setValue] = React.useState(() => documentText(document as never));
      React.useEffect(() => {
        const incoming = documentText(document as never);
        setValue((current) => (current === incoming ? current : incoming));
      }, [document]);
      return React.createElement("textarea", {
        "aria-label": ariaLabel,
        "data-presentation": presentation,
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

import type { NoteDto, NoteOverviewDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { createStandaloneNote, deleteOwnedNote, updateOwnedNote } from "./notesApi";
import { OwnedNoteEditor } from "./OwnedNoteEditor";

const mockedCreate = vi.mocked(createStandaloneNote);
const mockedUpdate = vi.mocked(updateOwnedNote);
const mockedDelete = vi.mocked(deleteOwnedNote);

function anchoredOverview(overrides: Partial<NoteOverviewDto> = {}): NoteOverviewDto {
  return {
    anchor: {
      blockEntryId: toEntryId("block-1"),
      contextSnapshot: "context",
      endBlockEntryId: toEntryId("block-1"),
      selectedTextSnapshot: "the source line"
    },
    authorName: "Aesop",
    blockEntryId: toEntryId("block-1"),
    bodyDoc: createTextDocument("original body"),
    bodyText: "original body",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    review: { status: "not_enrolled" },
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: toEntryId("work-a"),
    workTitle: "Aesop Fables",
    ...overrides
  };
}

function standaloneOverview(): NoteOverviewDto {
  return anchoredOverview({
    anchor: null,
    blockEntryId: null,
    captureSource: "manual",
    entryId: toEntryId("note-2"),
    workEntryId: null,
    workTitle: null
  });
}

const savedNote: NoteDto = { ...anchoredOverview() };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("OwnedNoteEditor create (#659)", () => {
  it("creates a standalone note from a non-blank body and reports it, with no source section", async () => {
    mockedCreate.mockResolvedValue(savedNote);
    const onSaved = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={onSaved}
        target={{ kind: "create" }}
      />
    );

    expect(screen.getByRole("heading", { name: "New note" })).toBeDefined();
    expect(screen.queryByText(/Source:/)).toBeNull();
    expect(screen.queryByTestId("owned-review-section")).toBeNull();
    // Note composition uses the workspace-sized editor, not the quick-input compact box (#677).
    expect(screen.getByLabelText("Note body").getAttribute("data-presentation")).toBe("workspace");

    await userEvent.type(screen.getByLabelText("Note body"), "a fresh thought");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedNote));
    expect(mockedCreate).toHaveBeenCalledWith({ bodyDoc: createTextDocument("a fresh thought") });
  });

  it("blocks a blank save and announces it", async () => {
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "create" }}
      />
    );

    expect(screen.getByRole("button", { name: "Save note" })).toHaveProperty("disabled", true);
    // The keyboard save path reaches the blank guard even while the button is disabled.
    await userEvent.type(screen.getByLabelText("Note body"), "{Control>}s{/Control}");

    expect(screen.getByRole("alert").textContent).toContain("Write something");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("closes without saving when cancelled", async () => {
    const onClose = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={onClose}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "create" }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("OwnedNoteEditor edit (#659)", () => {
  it("shows the anchored source, an Open-in-Reader link, and the review section", () => {
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    expect(screen.getByRole("heading", { name: "Edit note" })).toBeDefined();
    expect(screen.getByText(/Source:/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Open in Reader" }).getAttribute("href")).toBe(
      "#/reader?work=work-a&block=block-1"
    );
    expect(screen.getByTestId("owned-review-section")).toBeDefined();
  });

  it("saves an edit through the owner-scoped command", async () => {
    mockedUpdate.mockResolvedValue(savedNote);
    const onSaved = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={onSaved}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    const body = screen.getByLabelText("Note body");
    await userEvent.clear(body);
    await userEvent.type(body, "revised body");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedNote));
    expect(mockedUpdate).toHaveBeenCalledWith("note-1", {
      bodyDoc: createTextDocument("revised body")
    });
  });

  it("surfaces a save failure without blanking the note", async () => {
    mockedUpdate.mockRejectedValue(new Error("boom"));
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Could not save the note");
  });

  it("requires a named confirmation before deleting, then reports the deletion", async () => {
    mockedDelete.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={onDeleted}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    // The confirmation names the note by its source before the destructive action.
    expect(screen.getByText(/Delete this note/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("note-1"));
    expect(mockedDelete).toHaveBeenCalledWith("note-1");
  });

  it("keeps the note when the delete confirmation is dismissed", async () => {
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep note" }));

    expect(screen.queryByText(/Delete this note/)).toBeNull();
  });

  it("surfaces a delete failure without closing the editor", async () => {
    mockedDelete.mockRejectedValue(new Error("boom"));
    const onDeleted = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={onDeleted}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("forwards a review enrollment up so the host can refresh the list", async () => {
    const onReviewChanged = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={onReviewChanged}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview() }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "stub-enroll" }));
    expect(onReviewChanged).toHaveBeenCalledTimes(1);
  });

  it("omits the Open-in-Reader link when the anchored note's work cannot be resolved", () => {
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: anchoredOverview({ workEntryId: null }) }}
      />
    );

    expect(screen.getByText(/Source:/)).toBeDefined();
    expect(screen.queryByRole("link", { name: "Open in Reader" })).toBeNull();
  });

  it("names a standalone note without a source snapshot in the delete confirmation", async () => {
    mockedDelete.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={onDeleted}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: standaloneOverview() }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    const prompt = screen.getByText(/Delete this note/);
    expect(prompt.textContent).not.toContain("“");
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("note-2"));
  });

  it("edits a standalone note with no source section", () => {
    render(
      <OwnedNoteEditor
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onReviewChanged={vi.fn()}
        onSaved={vi.fn()}
        target={{ kind: "edit", note: standaloneOverview() }}
      />
    );

    expect(screen.queryByText(/Source:/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in Reader" })).toBeNull();
    expect(screen.getByTestId("owned-review-section")).toBeDefined();
    // Editing composes in the same workspace-sized editor as creating (#677).
    expect(screen.getByLabelText("Note body").getAttribute("data-presentation")).toBe("workspace");
  });
});
