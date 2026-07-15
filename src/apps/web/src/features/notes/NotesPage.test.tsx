// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  fetchAllNotes: vi.fn()
}));

import { fetchAllNotes } from "./notesApi";
import { NotesPage } from "./NotesPage";
import type { NoteOverviewDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

const mockedFetchAllNotes = vi.mocked(fetchAllNotes);

function note(
  entryId: string,
  blockEntryId: string,
  workEntryId: string,
  workTitle: string,
  authorName: string,
  selected: string,
  markdown: string
): NoteOverviewDto {
  return {
    anchor: {
      blockEntryId: toEntryId(blockEntryId),
      contextSnapshot: "context",
      endBlockEntryId: toEntryId(blockEntryId),
      selectedTextSnapshot: selected
    },
    authorName,
    blockEntryId: toEntryId(blockEntryId),
    bodyDoc: createTextDocument(markdown),
    bodyText: markdown,
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId(entryId),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: toEntryId(workEntryId),
    workTitle
  };
}

// An unanchored manual or Memory note: no source anchor, so it lists under the "Notes without a source"
// group with its body only — no snippet and no Open-in-Reader link.
function unanchoredNote(entryId: string, body: string): NoteOverviewDto {
  return {
    anchor: null,
    authorName: null,
    blockEntryId: null,
    bodyDoc: createTextDocument(body),
    bodyText: body,
    captureSource: "manual",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId(entryId),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: null,
    workTitle: null
  };
}

function mark(
  entryId: string,
  blockEntryId: string,
  workEntryId: string,
  workTitle: string,
  authorName: string,
  selected: string
): NoteOverviewDto {
  return {
    ...note(entryId, blockEntryId, workEntryId, workTitle, authorName, selected, ""),
    bodyDoc: null,
    bodyText: null,
    kind: "mark"
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("NotesPage", () => {
  it("lists notes grouped by work, each linking back to its anchored block", async () => {
    mockedFetchAllNotes.mockResolvedValue({
      notes: [
        note("note-1", "block-1", "work-a", "Aesop Fables", "Aesop", "brown fox", "to outwit"),
        mark("mark-1", "block-3", "work-a", "Aesop Fables", "Aesop", "sly"),
        note("note-2", "block-2", "work-b", "Zen Mind", "Suzuki", "beginner mind", "stay open")
      ]
    });

    render(<NotesPage />);

    expect(await screen.findByRole("heading", { level: 2, name: /Aesop Fables/ })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: /Zen Mind/ })).toBeDefined();
    expect(screen.getByText("“brown fox”")).toBeDefined();
    expect(screen.getByText("to outwit")).toBeDefined();
    // A bodyless mark still lists its anchored snippet but renders no body paragraph.
    expect(screen.getByText("“sly”")).toBeDefined();

    const links = screen.getAllByRole("link", { name: "Open in Reader" });
    expect(links[0]?.getAttribute("href")).toBe("#/reader?work=work-a&block=block-1");
    expect(links[1]?.getAttribute("href")).toBe("#/reader?work=work-a&block=block-3");
    expect(links[2]?.getAttribute("href")).toBe("#/reader?work=work-b&block=block-2");
    // Each action is a >=44px hit target in both dimensions (#475). jsdom has no layout, so assert the
    // sizing utilities (min-h-11 = min-w-11 = 44px); dropping min-h-11 fails here.
    for (const link of links) {
      expect(link.className).toContain("min-h-11");
      expect(link.className).toContain("min-w-11");
    }
  });

  it("shows an explicit empty state when the user has no notes", async () => {
    mockedFetchAllNotes.mockResolvedValue({ notes: [] });

    render(<NotesPage />);

    expect(
      await screen.findByText(
        "No notes yet. Open a work in the Reader and select text to create one."
      )
    ).toBeDefined();
  });

  it("narrows to a single work when a focus work is given", async () => {
    mockedFetchAllNotes.mockResolvedValue({
      notes: [
        note("note-1", "block-1", "work-a", "Aesop Fables", "Aesop", "brown fox", "to outwit"),
        note("note-2", "block-2", "work-b", "Zen Mind", "Suzuki", "beginner mind", "stay open")
      ]
    });

    render(<NotesPage focusWorkEntryId="work-b" />);

    expect(await screen.findByRole("heading", { level: 2, name: /Zen Mind/ })).toBeDefined();
    expect(screen.queryByRole("heading", { level: 2, name: /Aesop Fables/ })).toBeNull();
    expect(screen.queryByText("“brown fox”")).toBeNull();
    expect(screen.getByText("Every note you have saved in this work.")).toBeDefined();
  });

  it("shows a work-scoped empty state when the focused work has no notes", async () => {
    mockedFetchAllNotes.mockResolvedValue({
      notes: [
        note("note-1", "block-1", "work-a", "Aesop Fables", "Aesop", "brown fox", "to outwit")
      ]
    });

    render(<NotesPage focusWorkEntryId="work-missing" />);

    expect(
      await screen.findByText(
        "No notes yet for this work. Open it in the Reader and select text to create one."
      )
    ).toBeDefined();
  });

  it("shows an error state when notes fail to load", async () => {
    mockedFetchAllNotes.mockRejectedValue(new Error("boom"));

    render(<NotesPage />);

    expect(await screen.findByText("Could not load your notes. Please try again.")).toBeDefined();
  });

  it("lists unanchored notes body-only under a source-less group with no reader link", async () => {
    mockedFetchAllNotes.mockResolvedValue({
      notes: [
        note("note-1", "block-1", "work-a", "Aesop Fables", "Aesop", "brown fox", "to outwit"),
        unanchoredNote("mem-1", "a memory without a source")
      ]
    });

    render(<NotesPage />);

    // The unanchored note groups under a generic header, shows its body, and offers no snippet/link.
    expect(
      await screen.findByRole("heading", { level: 2, name: "Notes without a source" })
    ).toBeDefined();
    expect(screen.getByText("a memory without a source")).toBeDefined();
    // Only the anchored note contributes a snippet and an Open-in-Reader link.
    expect(screen.getByText("“brown fox”")).toBeDefined();
    expect(screen.getAllByRole("link", { name: "Open in Reader" })).toHaveLength(1);
  });
});
