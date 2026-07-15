// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteList } from "./NoteList";
import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

function makeNote(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("block-1"),
      contextSnapshot: "The quick brown fox.",
      endBlockEntryId: toEntryId("block-1"),
      selectedTextSnapshot: "fox"
    },
    blockEntryId: toEntryId("block-1"),
    bodyDoc: createTextDocument("a sly animal"),
    bodyText: "a sly animal",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeMark(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return makeNote({
    bodyDoc: null,
    bodyText: null,
    entryId: toEntryId("mark-1"),
    kind: "mark",
    ...overrides
  });
}

function renderList(
  notes: ReadonlyArray<AnchoredNoteDto>,
  handlers: Partial<{
    onDelete: (note: AnchoredNoteDto) => void;
    onEdit: (note: AnchoredNoteDto) => void;
    onJump: (note: AnchoredNoteDto) => void;
  }> = {}
): void {
  render(
    <NoteList
      emptyLabel="No notes yet."
      notes={notes}
      onDelete={handlers.onDelete ?? vi.fn()}
      onEdit={handlers.onEdit ?? vi.fn()}
      onJump={handlers.onJump ?? vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("NoteList", () => {
  it("shows the empty label when there are no notes", () => {
    renderList([]);

    expect(screen.getByText("No notes yet.")).toBeDefined();
  });

  it("renders a note's snippet, Note chip, and derived body preview", () => {
    renderList([makeNote()]);

    expect(screen.getByText(/fox/)).toBeDefined();
    const chip = screen.getByText("Note");
    expect(chip.className).toContain("noteCardChip--note");
    expect(screen.getByText("a sly animal")).toBeDefined();
  });

  it("invokes jump, edit, and delete callbacks with the chosen note", async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onJump = vi.fn();
    const note = makeNote();
    const user = userEvent.setup();
    renderList([note], { onDelete, onEdit, onJump });

    await user.click(screen.getByRole("button", { name: "Jump to text: fox" }));
    expect(onJump).toHaveBeenCalledWith(note);

    await user.click(screen.getByRole("button", { name: "Edit note: fox" }));
    expect(onEdit).toHaveBeenCalledWith(note);

    await user.click(screen.getByRole("button", { name: "Delete note: fox" }));
    expect(onDelete).toHaveBeenCalledWith(note);
  });

  it("renders a bodyless mark as a Mark card with no body or edit, still removable", async () => {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const mark = makeMark();
    const user = userEvent.setup();
    renderList([mark], { onDelete, onEdit });

    const chip = screen.getByText("Mark");
    expect(chip.className).toContain("noteCardChip--mark");
    expect(screen.getByText(/fox/)).toBeDefined();
    expect(screen.queryByText("a sly animal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit note: fox" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete mark: fox" }));
    expect(onDelete).toHaveBeenCalledWith(mark);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
