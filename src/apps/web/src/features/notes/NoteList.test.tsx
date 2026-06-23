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

afterEach(() => {
  cleanup();
});

describe("NoteList", () => {
  it("shows the empty label when there are no notes", () => {
    render(
      <NoteList
        emptyLabel="No notes yet."
        notes={[]}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        templates={templates}
      />
    );

    expect(screen.getByText("No notes yet.")).toBeDefined();
  });

  it("renders each note's snippet, template name, and rendered body", () => {
    render(
      <NoteList
        emptyLabel="No notes yet."
        notes={[makeNote()]}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        templates={templates}
      />
    );

    expect(screen.getByText(/fox/)).toBeDefined();
    expect(screen.getByText("Vocabulary")).toBeDefined();
    expect(screen.getByText("a sly animal")).toBeDefined();
  });

  it("falls back to the template id when the template is unknown", () => {
    render(
      <NoteList
        emptyLabel="No notes yet."
        notes={[makeNote({ templateId: "gone" })]}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        templates={templates}
      />
    );

    expect(screen.getByText("gone")).toBeDefined();
  });

  it("invokes the edit and delete callbacks with the chosen note", async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const note = makeNote();
    const user = userEvent.setup();
    render(
      <NoteList
        emptyLabel="No notes yet."
        notes={[note]}
        onDelete={onDelete}
        onEdit={onEdit}
        templates={templates}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit note: fox" }));
    expect(onEdit).toHaveBeenCalledWith(note);

    await user.click(screen.getByRole("button", { name: "Delete note: fox" }));
    expect(onDelete).toHaveBeenCalledWith(note);
  });
});
