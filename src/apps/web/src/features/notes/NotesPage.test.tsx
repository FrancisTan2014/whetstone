// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  fetchAllNotes: vi.fn()
}));

import { fetchAllNotes } from "./notesApi";
import { NotesPage } from "./NotesPage";
import type { NoteOverviewDto } from "@whetstone/contracts";
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
      selectedTextSnapshot: selected
    },
    answers: {},
    authorName,
    blockEntryId: toEntryId(blockEntryId),
    entryId: toEntryId(entryId),
    markdown,
    templateId: "thought",
    workEntryId: toEntryId(workEntryId),
    workTitle
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
        note("note-2", "block-2", "work-b", "Zen Mind", "Suzuki", "beginner mind", "stay open")
      ]
    });

    render(<NotesPage />);

    expect(await screen.findByRole("heading", { level: 2, name: /Aesop Fables/ })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: /Zen Mind/ })).toBeDefined();
    expect(screen.getByText("“brown fox”")).toBeDefined();
    expect(screen.getByText("to outwit")).toBeDefined();

    const links = screen.getAllByRole("link", { name: "Open in Reader" });
    expect(links[0]?.getAttribute("href")).toBe("#/reader?work=work-a&block=block-1");
    expect(links[1]?.getAttribute("href")).toBe("#/reader?work=work-b&block=block-2");
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

  it("shows an error state when notes fail to load", async () => {
    mockedFetchAllNotes.mockRejectedValue(new Error("boom"));

    render(<NotesPage />);

    expect(await screen.findByText("Could not load your notes. Please try again.")).toBeDefined();
  });
});
