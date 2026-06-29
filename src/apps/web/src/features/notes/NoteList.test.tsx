// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteList } from "./NoteList";
import type { NoteDto, NoteTemplateDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

const templates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [{ id: "meaning", label: "Meaning in this context", type: "long_text" }],
    id: "vocabulary",
    name: "Vocabulary"
  }
];

function makeNote(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("block-1"),
      contextSnapshot: "The quick brown fox.",
      selectedTextSnapshot: "fox"
    },
    answers: { meaning: "a sly animal" },
    blockEntryId: toEntryId("block-1"),
    entryId: toEntryId("note-1"),
    markdown: "**Meaning in this context**\n\na sly animal",
    templateId: "vocabulary",
    ...overrides
  };
}

function renderList(
  notes: ReadonlyArray<NoteDto>,
  handlers: Partial<{
    onDelete: (note: NoteDto) => void;
    onEdit: (note: NoteDto) => void;
    onJump: (note: NoteDto) => void;
  }> = {}
): void {
  render(
    <NoteList
      emptyLabel="No notes yet."
      notes={notes}
      onDelete={handlers.onDelete ?? vi.fn()}
      onEdit={handlers.onEdit ?? vi.fn()}
      onJump={handlers.onJump ?? vi.fn()}
      templates={templates}
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

  it("renders each note's snippet, template name chip, and rendered body", () => {
    renderList([makeNote()]);

    expect(screen.getByText(/fox/)).toBeDefined();
    expect(screen.getByText("Vocabulary")).toBeDefined();
    expect(screen.getByText("a sly animal")).toBeDefined();
  });

  it("falls back to the raw template id as the chip label when the template is unknown", () => {
    renderList([makeNote({ templateId: "gone" })]);

    expect(screen.getByText("gone")).toBeDefined();
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

  it("renders a mark (null template) as a Gem card with no body or edit, still removable", async () => {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const mark = makeNote({
      answers: {},
      entryId: toEntryId("mark-1"),
      markdown: "",
      templateId: null
    });
    const user = userEvent.setup();
    renderList([mark], { onDelete, onEdit });

    // A dedicated "Gem" chip with its gem swatch, the snippet, and no Edit control.
    const chip = screen.getByText("Gem");
    expect(chip.className).toContain("templateHue--gem");
    expect(screen.getByText(/fox/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit note: fox" })).toBeNull();

    // Removable via its delete control.
    await user.click(screen.getByRole("button", { name: "Delete mark: fox" }));
    expect(onDelete).toHaveBeenCalledWith(mark);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
