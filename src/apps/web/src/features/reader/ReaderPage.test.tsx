// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./readerApi", () => ({
  fetchWorkContent: vi.fn(),
  fetchWorks: vi.fn()
}));

vi.mock("../notes/notesApi", () => ({
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  fetchNoteTemplates: vi.fn(),
  fetchNotes: vi.fn(),
  updateNote: vi.fn()
}));

import {
  createNote,
  deleteNote,
  fetchNoteTemplates,
  fetchNotes,
  updateNote
} from "../notes/notesApi";
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { ReaderPage } from "./ReaderPage";
import type {
  NoteDto,
  NoteTemplateDto,
  WorkContentDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkContent = vi.mocked(fetchWorkContent);
const mockedFetchNoteTemplates = vi.mocked(fetchNoteTemplates);
const mockedCreateNote = vi.mocked(createNote);
const mockedFetchNotes = vi.mocked(fetchNotes);
const mockedUpdateNote = vi.mocked(updateNote);
const mockedDeleteNote = vi.mocked(deleteNote);

const noteTemplates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [{ id: "meaning", label: "Meaning in this context", type: "long_text" }],
    id: "vocabulary",
    name: "Vocabulary"
  }
];

const author = { id: toAuthorId("author-1"), name: "George Orwell" };

const workA: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-1"),
    language: "en",
    title: "Politics and the English Language",
    workType: "essay"
  }
};

const workB: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-2"),
    language: "en",
    title: "A Tale of Two Cities",
    workType: "book"
  }
};

function emptyContent(workEntryId: string): WorkContentDto {
  return { readingUnits: [], workEntryId: toEntryId(workEntryId) };
}

// Units and blocks are stored out of reading order to confirm the page renders them
// sorted, grouped by unit, as one continuous scroll.
const multiUnitContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("b-2"),
          mdast: { children: [{ type: "text", value: "Heading text" }], depth: 2, type: "heading" },
          orderIndex: 0,
          plaintext: "Heading text"
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-3"),
          mdast: {
            children: [
              { children: [{ type: "text", value: "emphasized word" }], type: "emphasis" }
            ],
            type: "paragraph"
          },
          orderIndex: 1,
          plaintext: "emphasized word"
        }
      ],
      entryId: toEntryId("u-2"),
      orderIndex: 1,
      title: "Section Two"
    },
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-1"),
          mdast: { children: [{ type: "text", value: "Intro paragraph." }], type: "paragraph" },
          orderIndex: 0,
          plaintext: "Intro paragraph."
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

// A block whose plaintext repeats a word, so selecting the second occurrence must anchor
// to that occurrence rather than the first match.
const repeatedContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-rep"),
          mdast: {
            children: [{ type: "text", value: "the cat sat on the mat" }],
            type: "paragraph"
          },
          orderIndex: 0,
          plaintext: "the cat sat on the mat"
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

const unsafeContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("b-safe"),
          mdast: { children: [{ type: "text", value: "Safe heading" }], depth: 1, type: "heading" },
          orderIndex: 0,
          plaintext: "Safe heading"
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-evil"),
          mdast: { type: "html", value: "<script>window.__xssReader = true;</script>" },
          orderIndex: 1,
          plaintext: ""
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

function firstTextNode(blockElement: HTMLElement): Text {
  const walker = document.createTreeWalker(blockElement, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();

  if (node === null) {
    throw new Error("block has no text node");
  }

  return node as Text;
}

function selectRangeIn(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);

  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectText(blockElement: HTMLElement, text: string): void {
  const node = firstTextNode(blockElement);
  const start = (node.textContent ?? "").indexOf(text);
  selectRangeIn(node, start, start + text.length);
}

function blockElement(container: HTMLElement, blockId: string): HTMLElement {
  return container.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
  mockedFetchWorks.mockResolvedValue({ works: [workA] });
  mockedFetchWorkContent.mockResolvedValue(emptyContent("work-1"));
  mockedFetchNoteTemplates.mockResolvedValue({ templates: noteTemplates });
  mockedFetchNotes.mockResolvedValue({ notes: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("ReaderPage", () => {
  it("shows a loading state before works resolve", async () => {
    render(<ReaderPage />);

    expect(screen.getByText("Loading works…")).toBeDefined();
    await screen.findByRole("button", { name: "Politics and the English Language" });
  });

  it("shows an error when works fail to load", async () => {
    mockedFetchWorks.mockRejectedValue(new Error("network"));

    render(<ReaderPage />);

    expect(await screen.findByText("Could not load works.")).toBeDefined();
  });

  it("prompts to create a work when none exist", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [] });

    render(<ReaderPage />);

    expect(await screen.findByText("No works yet. Create one in the library admin.")).toBeDefined();
  });

  it("lists works and prompts the reader to open one", async () => {
    render(<ReaderPage />);

    const openButton = await screen.findByRole("button", {
      name: "Politics and the English Language"
    });

    expect(screen.getByText("Select a work to start reading.")).toBeDefined();
    expect(openButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens a work and renders its units and blocks as one continuous scroll", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Section Two" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();
    expect(container.querySelector("em")?.textContent).toBe("emphasized word");

    const blockIds = Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
      element.getAttribute("data-block-id")
    );
    expect(blockIds).toEqual(["b-1", "b-2", "b-3"]);

    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-1");
    expect(
      screen
        .getByRole("button", { name: "Politics and the English Language" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("shows the untitled unit without a heading", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    expect(screen.queryByRole("heading", { name: "Untitled section" })).toBeNull();
    expect(
      within(screen.getByRole("article", { name: "Reading" })).getAllByRole("heading", { level: 2 })
    ).toHaveLength(2);
  });

  it("shows a loading state while a work's content loads", async () => {
    let resolveContent!: (value: WorkContentDto) => void;
    mockedFetchWorkContent.mockReturnValue(
      new Promise<WorkContentDto>((resolve) => {
        resolveContent = resolve;
      })
    );
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(screen.getByText("Loading the work…")).toBeDefined();

    resolveContent(emptyContent("work-1"));

    expect(await screen.findByText("This work has no content yet.")).toBeDefined();
  });

  it("shows an error when a work's content fails to load", async () => {
    mockedFetchWorkContent.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByText("Could not load this work. Please try again.")).toBeDefined();
  });

  it("shows a message when an opened work has no content", async () => {
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByText("This work has no content yet.")).toBeDefined();
  });

  it("marks only the open work as pressed among several", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    expect(
      screen
        .getByRole("button", { name: "Politics and the English Language" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "A Tale of Two Cities" }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("renders Markdown safely and does not execute raw HTML", async () => {
    mockedFetchWorkContent.mockResolvedValue(unsafeContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Safe heading" })).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("__xssReader");
  });

  it("opens the note editor when text is selected in a block", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    expect(await screen.findByRole("heading", { name: "New note" })).toBeDefined();
    expect(screen.getByText(/Selected: Intro/)).toBeDefined();
  });

  it("anchors a note to the selected occurrence of repeated text", async () => {
    mockedFetchWorkContent.mockResolvedValue(repeatedContent);
    mockedCreateNote.mockResolvedValue({ entryId: "note-1" } as unknown as NoteDto);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    const block = await screen.findByText("the cat sat on the mat");
    // Select the second "the" (offset 15-18), not the first match at offset 0.
    selectRangeIn(firstTextNode(block as HTMLElement), 15, 18);
    fireEvent.mouseUp(blockElement(container, "b-rep"));

    await user.type(await screen.findByLabelText("Meaning in this context"), "definite article");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(mockedCreateNote).toHaveBeenCalledWith("work-1", {
      answers: { meaning: "definite article" },
      anchor: {
        blockEntryId: "b-rep",
        contextSnapshot: "the cat sat on the mat",
        endOffset: 18,
        selectedTextSnapshot: "the",
        startOffset: 15
      },
      templateId: "vocabulary"
    });
  });

  it("does not open the editor when there is no selection", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(blockElement(container, "b-1"));

    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("does not open the editor for a whitespace-only selection", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    const block = await screen.findByText("Intro paragraph.");
    // "Intro paragraph." has a space at index 5.
    selectRangeIn(firstTextNode(block as HTMLElement), 5, 6);
    fireEvent.mouseUp(blockElement(container, "b-1"));

    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("confirms and closes the editor after a note is saved", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedCreateNote.mockResolvedValue({ entryId: "note-1" } as unknown as NoteDto);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    await user.type(await screen.findByLabelText("Meaning in this context"), "the start");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("closes the editor when cancelled", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    await screen.findByRole("heading", { name: "New note" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("shows the unavailable editor when note templates fail to load", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedFetchNoteTemplates.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    expect(
      await screen.findByText("Note templates are unavailable. Please try again.")
    ).toBeDefined();
  });
});

function makeNote(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("b-1"),
      contextSnapshot: "Intro paragraph.",
      selectedTextSnapshot: "Intro"
    },
    answers: { meaning: "the beginning" },
    blockEntryId: toEntryId("b-1"),
    entryId: toEntryId("note-1"),
    markdown: "**Meaning in this context**\n\nthe beginning",
    templateId: "vocabulary",
    ...overrides
  };
}

async function openWorkWithNotes(notes: ReadonlyArray<NoteDto>): Promise<HTMLElement> {
  mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
  mockedFetchNotes.mockResolvedValue({ notes });
  const user = userEvent.setup();
  const { container } = render(<ReaderPage />);

  await user.click(
    await screen.findByRole("button", { name: "Politics and the English Language" })
  );
  await screen.findByText("Intro paragraph.");

  return container;
}

describe("ReaderPage note management", () => {
  it("highlights blocks that have notes and labels the count", async () => {
    const container = await openWorkWithNotes([makeNote()]);

    const annotated = blockElement(container, "b-1");
    expect(annotated.getAttribute("data-has-notes")).toBe("true");
    expect(annotated.className).toContain("readerBlock--annotated");

    const plain = blockElement(container, "b-2");
    expect(plain.getAttribute("data-has-notes")).toBeNull();
    expect(plain.className).not.toContain("readerBlock--annotated");

    expect(screen.getByRole("button", { name: "View 1 note" })).toBeDefined();
  });

  it("lists a per-work note with its anchored snippet", async () => {
    await openWorkWithNotes([makeNote()]);

    const region = screen.getByRole("region", { name: "Your notes" });
    expect(within(region).getByText(/Intro/)).toBeDefined();
    expect(within(region).getByText("the beginning")).toBeDefined();
  });

  it("reopens a block's notes from its highlight and edits one", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedFetchNotes.mockResolvedValueOnce({ notes: [makeNote()] });
    const updated = makeNote({ answers: { meaning: "a fresh start" } });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [updated] });
    mockedUpdateNote.mockResolvedValue(updated);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    await user.click(screen.getByRole("button", { name: "View 1 note" }));

    const panel = await screen.findByRole("complementary", { name: "Block notes" });
    await user.click(within(panel).getByRole("button", { name: "Edit note: Intro" }));

    expect(await screen.findByRole("heading", { name: "Edit note" })).toBeDefined();
    const field = screen.getByLabelText("Meaning in this context") as HTMLTextAreaElement;
    expect(field.value).toBe("the beginning");

    await user.clear(field);
    await user.type(field, "a fresh start");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Edit note" })).toBeNull();
    expect(mockedUpdateNote).toHaveBeenCalledWith("work-1", "note-1", {
      answers: { meaning: "a fresh start" },
      templateId: "vocabulary"
    });
  });

  it("lists multiple notes for a block and deletes one", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const first = makeNote({ entryId: toEntryId("note-1") });
    const second = makeNote({
      anchor: {
        blockEntryId: toEntryId("b-1"),
        contextSnapshot: "Intro paragraph.",
        selectedTextSnapshot: "paragraph"
      },
      entryId: toEntryId("note-2")
    });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [first, second] });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [second] });
    mockedDeleteNote.mockResolvedValue();
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    await user.click(screen.getByRole("button", { name: "View 2 notes" }));

    const panel = await screen.findByRole("complementary", { name: "Block notes" });
    expect(within(panel).getAllByRole("button", { name: /^Edit note:/ })).toHaveLength(2);

    await user.click(within(panel).getByRole("button", { name: "Delete note: Intro" }));

    expect(await screen.findByText("Note deleted.")).toBeDefined();
    expect(mockedDeleteNote).toHaveBeenCalledWith("work-1", "note-1");
  });

  it("closes the block notes panel", async () => {
    await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "View 1 note" }));
    await screen.findByRole("complementary", { name: "Block notes" });

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("complementary", { name: "Block notes" })).toBeNull();
  });

  it("edits a note from the per-work note list", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedFetchNotes.mockResolvedValueOnce({ notes: [makeNote()] });
    const updated = makeNote({ answers: { meaning: "edited" } });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [updated] });
    mockedUpdateNote.mockResolvedValue(updated);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    const region = screen.getByRole("region", { name: "Your notes" });
    await user.click(within(region).getByRole("button", { name: "Edit note: Intro" }));

    expect(await screen.findByRole("heading", { name: "Edit note" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(mockedUpdateNote).toHaveBeenCalledWith("work-1", "note-1", {
      answers: { meaning: "the beginning" },
      templateId: "vocabulary"
    });
  });

  it("deletes a note from the per-work note list", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedFetchNotes.mockResolvedValueOnce({ notes: [makeNote()] });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [] });
    mockedDeleteNote.mockResolvedValue();
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    const region = screen.getByRole("region", { name: "Your notes" });
    await user.click(within(region).getByRole("button", { name: "Delete note: Intro" }));

    expect(await screen.findByText("Note deleted.")).toBeDefined();
    expect(mockedDeleteNote).toHaveBeenCalledWith("work-1", "note-1");
    expect(screen.getByText("No notes yet. Select text in the reader to add one.")).toBeDefined();
  });

  it("shows an error when deleting a note fails", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedFetchNotes.mockResolvedValue({ notes: [makeNote()] });
    mockedDeleteNote.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    const region = screen.getByRole("region", { name: "Your notes" });
    await user.click(within(region).getByRole("button", { name: "Delete note: Intro" }));

    expect(await screen.findByText("Could not delete the note. Please try again.")).toBeDefined();
  });
});
