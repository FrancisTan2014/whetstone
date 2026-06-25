// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../shared/ui/toast/ToastProvider";
import { ToastViewport } from "../../shared/ui/toast/ToastViewport";

// The reader reports note results through the app-wide toast system, so its renders run
// inside a ToastProvider with the shell's live region mounted — the same way the app wires
// it — letting the existing "Note saved." assertions resolve against the real viewport.
function ToastHost({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ToastProvider>
      {children}
      <ToastViewport />
    </ToastProvider>
  );
}

function render(ui: React.ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { wrapper: ToastHost });
}

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

vi.mock("../lookup/lookupApi", () => ({
  lookupTerm: vi.fn()
}));

import {
  createNote,
  deleteNote,
  fetchNoteTemplates,
  fetchNotes,
  updateNote
} from "../notes/notesApi";
import { lookupTerm } from "../lookup/lookupApi";
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { applyUnitForBlock, applyUnitSelection, ReaderPage, viewingPosition } from "./ReaderPage";
import { readingPositionKey } from "./readingPosition";
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
const mockedLookupTerm = vi.mocked(lookupTerm);

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

const chineseWork: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-zh"),
    language: "zh-CN",
    title: "中文测试",
    workType: "essay"
  }
};

const chineseContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-zh"),
          mdast: { children: [{ type: "text", value: "你好世界" }], type: "paragraph" },
          orderIndex: 0,
          plaintext: "你好世界"
        }
      ],
      entryId: toEntryId("u-zh"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-zh")
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

// A block whose serialized Markdown contains an image, to confirm the reader's sanitize
// schema strips it (defense in depth — ingestion already drops images).
const imageContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-img"),
          mdast: {
            children: [
              { type: "text", value: "Visible caption text." },
              {
                alt: "Cover image",
                title: null,
                type: "image",
                url: "http://example.test/cover.png"
              }
            ],
            type: "paragraph"
          },
          orderIndex: 0,
          plaintext: "Visible caption text."
        }
      ],
      entryId: toEntryId("u-img"),
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

const linkContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-1"),
          mdast: {
            children: [
              { type: "text", value: "See " },
              { children: [{ type: "text", value: "Chapter 2" }], type: "link", url: "#chapter-2" },
              { type: "text", value: " for details." }
            ],
            type: "paragraph"
          },
          orderIndex: 0,
          plaintext: "See Chapter 2 for details."
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
  // jsdom does not implement scrollIntoView; the jump-back affordance calls it.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // jsdom does not implement scrollTo; restoring a saved offset calls it.
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn(), writable: true });
  // Reading position persists to localStorage; clear it so cases do not leak into each other.
  window.localStorage.clear();
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

  it("opens the requested work on arrival when given an initial work entry id", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);

    render(<ReaderPage initialWorkEntryId="work-2" />);

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-2");
    expect(
      screen.getByRole("button", { name: "A Tale of Two Cities" }).getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("opens the unit deep-linked by a block param and scrolls to that block", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const { container } = render(
      <ReaderPage initialBlockEntryId="b-2" initialWorkEntryId="work-1" />
    );

    // b-2 lives in the second unit, so the reader opens straight into that unit.
    expect(await screen.findByText("Heading text")).toBeDefined();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(blockElement(container, "b-2")?.scrollIntoView).toHaveBeenCalled();
  });

  it("falls back to the work picker when the initial work entry id is unknown", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });

    render(<ReaderPage initialWorkEntryId="missing-work" />);

    expect(await screen.findByText("Select a work to start reading.")).toBeDefined();
    expect(mockedFetchWorkContent).not.toHaveBeenCalled();
  });

  it("does not render an image even when a block's Markdown contains one", async () => {
    mockedFetchWorkContent.mockResolvedValue(imageContent);

    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Visible caption text.")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders only the active reading unit and switches units via the 目录", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    // The first unit opens by default; the second unit's blocks are not mounted yet.
    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(screen.queryByRole("heading", { level: 2, name: "Heading text" })).toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
        element.getAttribute("data-block-id")
      )
    ).toEqual(["b-1"]);

    // Selecting the second unit in the 目录 swaps the rendered content.
    const toc = screen.getByRole("navigation", { name: "目录" });
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();
    expect(container.querySelector("em")?.textContent).toBe("emphasized word");
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
        element.getAttribute("data-block-id")
      )
    ).toEqual(["b-2", "b-3"]);

    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-1");
    expect(
      screen
        .getByRole("button", { name: "Politics and the English Language" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("reads a single-unit work without a 目录", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [chineseWork] });
    mockedFetchWorkContent.mockResolvedValue(chineseContent);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(await screen.findByRole("button", { name: "中文测试" }));

    expect(await screen.findByText("你好世界")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "目录" })).toBeNull();
  });

  it("shows the untitled active unit without a heading", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    // The first unit is untitled, so the reading article renders no chapter heading.
    expect(
      within(screen.getByRole("article", { name: "Reading" })).queryAllByRole("heading", {
        level: 2
      })
    ).toHaveLength(0);

    // Switching to the titled unit shows its title heading plus its content heading.
    await user.click(
      within(screen.getByRole("navigation", { name: "目录" })).getByRole("button", {
        name: "Section Two"
      })
    );
    expect(
      within(await screen.findByRole("article", { name: "Reading" })).getAllByRole("heading", {
        level: 2
      })
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

  it("renders in-content links as non-navigating text that stays selectable", async () => {
    mockedFetchWorkContent.mockResolvedValue(linkContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Chapter 2");
    const block = blockElement(container, "b-1");

    // The link text is kept, but there is no navigating anchor — it renders as a plain span.
    expect(block.querySelector("a")).toBeNull();
    const link = block.querySelector(".readerLink");
    expect(link?.tagName).toBe("SPAN");
    expect(link?.textContent).toBe("Chapter 2");

    // Selecting the former link text still opens the selection toolbar (no navigation).
    const linkText = link?.firstChild as Text;
    const range = document.createRange();
    range.setStart(linkText, 0);
    range.setEnd(linkText, "Chapter 2".length);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(block);

    expect(await screen.findByRole("button", { name: "Add note" })).toBeDefined();
  });

  it("opens the selection toolbar then the editor when text is selected in a block", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Add note" }));

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

    await user.click(await screen.findByRole("button", { name: "Add note" }));
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

  it("does not open the toolbar when there is no selection", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(blockElement(container, "b-1"));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("does not open the toolbar for a whitespace-only selection", async () => {
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

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
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

    await user.click(await screen.findByRole("button", { name: "Add note" }));
    await user.type(await screen.findByLabelText("Meaning in this context"), "the start");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("dismisses the selection toolbar without opening the editor", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
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
    await user.click(await screen.findByRole("button", { name: "Add note" }));
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

    await user.click(await screen.findByRole("button", { name: "Add note" }));

    expect(
      await screen.findByText("Note templates are unavailable. Please try again.")
    ).toBeDefined();
  });
});

const threeTemplates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [{ id: "meaning", label: "Meaning in this context", type: "long_text" }],
    id: "vocabulary",
    name: "Vocabulary"
  },
  {
    fields: [{ id: "noticed", label: "What I noticed", type: "long_text" }],
    id: "expression",
    name: "Expression"
  },
  {
    fields: [{ id: "thought", label: "What I thought", type: "long_text" }],
    id: "thought",
    name: "Thought"
  }
];

async function openHuedReader(): Promise<{
  container: HTMLElement;
  user: ReturnType<typeof userEvent.setup>;
}> {
  mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
  mockedFetchNoteTemplates.mockResolvedValue({ templates: threeTemplates });
  const user = userEvent.setup();
  const { container } = render(<ReaderPage />);

  await user.click(
    await screen.findByRole("button", { name: "Politics and the English Language" })
  );
  await screen.findByText("Intro paragraph.");

  return { container, user };
}

describe("ReaderPage selection toolbar", () => {
  it("preselects the size-based template (one word picks Vocabulary)", async () => {
    const { container } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    await screen.findByRole("toolbar", { name: "Annotate selection" });
    expect(screen.getByRole("button", { name: "Vocabulary" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Expression" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("carries the toolbar's switched template into the editor", async () => {
    const { container, user } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    await user.click(await screen.findByRole("button", { name: "Expression" }));
    await user.click(screen.getByRole("button", { name: "Add note" }));

    await screen.findByRole("heading", { name: "New note" });
    expect(screen.getByRole("button", { name: "Expression" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("opens the toolbar from the keyboard (key-up over a selection)", async () => {
    const { container } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.keyUp(block);

    expect(await screen.findByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });

  it("opens the toolbar from touch (touch-end over a selection)", async () => {
    const { container } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.touchEnd(block);

    expect(await screen.findByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });

  it("births the saved block's highlight and confirms with a toast", async () => {
    mockedCreateNote.mockResolvedValue(makeNote());
    const { container, user } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    await user.click(await screen.findByRole("button", { name: "Add note" }));
    await user.type(await screen.findByLabelText("Meaning in this context"), "the start");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(blockElement(container, "b-1").getAttribute("data-born")).toBe("true");
  });

  it("shows the highlight instantly and still toasts under reduced motion", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      onchange: null,
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia;

    try {
      mockedCreateNote.mockResolvedValue(makeNote());
      const { container, user } = await openHuedReader();
      const block = blockElement(container, "b-1");

      selectText(block, "Intro");
      fireEvent.mouseUp(block);
      await user.click(await screen.findByRole("button", { name: "Add note" }));
      await user.type(await screen.findByLabelText("Meaning in this context"), "the start");
      await user.click(screen.getByRole("button", { name: "Save note" }));

      expect(await screen.findByText("Note saved.")).toBeDefined();
      expect(blockElement(container, "b-1").getAttribute("data-born")).toBe("true");
    } finally {
      window.matchMedia = original;
    }
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
    const user = userEvent.setup();

    const annotated = blockElement(container, "b-1");
    expect(annotated.getAttribute("data-has-notes")).toBe("true");
    expect(annotated.className).toContain("readerBlock--annotated");
    expect(screen.getByRole("button", { name: "View 1 note" })).toBeDefined();

    // A block in another unit, with no note, renders plain once that unit is opened.
    await user.click(
      within(screen.getByRole("navigation", { name: "目录" })).getByRole("button", {
        name: "Section Two"
      })
    );
    await screen.findByText("Heading text");
    const plain = blockElement(container, "b-2");
    expect(plain.getAttribute("data-has-notes")).toBeNull();
    expect(plain.className).not.toContain("readerBlock--annotated");
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

  it("jumps back to the annotated block from a per-work note card", async () => {
    const container = await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();

    const region = screen.getByRole("region", { name: "Your notes" });
    await user.click(within(region).getByRole("button", { name: "Jump to text: Intro" }));

    const block = blockElement(container, "b-1");
    expect(block.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(block);
  });

  it("jumps back to the block from the block-notes panel", async () => {
    const container = await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "View 1 note" }));
    const panel = await screen.findByRole("complementary", { name: "Block notes" });
    await user.click(within(panel).getByRole("button", { name: "Jump to text: Intro" }));

    expect(document.activeElement).toBe(blockElement(container, "b-1"));
  });

  it("loads the holding unit and scrolls when jumping to a note in another unit", async () => {
    const otherUnitNote = makeNote({
      anchor: {
        blockEntryId: toEntryId("b-2"),
        contextSnapshot: "Heading text",
        selectedTextSnapshot: "Heading"
      },
      blockEntryId: toEntryId("b-2")
    });
    const container = await openWorkWithNotes([otherUnitNote]);
    const user = userEvent.setup();

    // The note lives in the second unit, which is not the open one.
    expect(blockElement(container, "b-2")).toBeNull();

    const region = screen.getByRole("region", { name: "Your notes" });
    await user.click(within(region).getByRole("button", { name: "Jump to text: Heading" }));

    const target = await screen.findByText("Heading text");
    expect(blockElement(container, "b-2")).not.toBeNull();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(target.closest("[data-block-id]")?.scrollIntoView).toHaveBeenCalled();
  });
});

describe("ReaderPage reading controls", () => {
  async function openMultiUnitWork(): Promise<HTMLElement> {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);
    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    return container;
  }

  function surfaceIn(container: HTMLElement): HTMLElement {
    return container.querySelector(".reading-surface") as HTMLElement;
  }

  it("applies the work's language to the reading surface for language-aware typography", async () => {
    const container = await openMultiUnitWork();

    expect(surfaceIn(container).getAttribute("lang")).toBe("en");
  });

  it("changes the reading text size via the size control", async () => {
    const user = userEvent.setup();
    const container = await openMultiUnitWork();

    expect(surfaceIn(container).style.getPropertyValue("--reading-size")).toBe("1.125rem");

    await user.click(screen.getByRole("button", { name: "Increase reading text size" }));
    expect(surfaceIn(container).style.getPropertyValue("--reading-size")).toBe("1.3125rem");

    await user.click(screen.getByRole("button", { name: "Decrease reading text size" }));
    expect(surfaceIn(container).style.getPropertyValue("--reading-size")).toBe("1.125rem");
  });

  it("tints annotated blocks with the note's annotation hue", async () => {
    const container = await openWorkWithNotes([makeNote()]);

    expect(blockElement(container, "b-1").className).toContain("readerBlock--vocab");
  });

  it("auto-hides the reading header on scroll down and restores it on scroll up", async () => {
    const container = await openMultiUnitWork();
    const header = (): HTMLElement => container.querySelector(".readingHeader") as HTMLElement;
    expect(header().className).not.toContain("readingHeader--hidden");

    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    fireEvent.scroll(window);
    expect(header().getAttribute("data-hidden")).toBe("true");

    Object.defineProperty(window, "scrollY", { configurable: true, value: 50 });
    fireEvent.scroll(window);
    expect(header().className).not.toContain("readingHeader--hidden");

    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("renders under a reduced-motion preference", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      onchange: null,
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia;

    try {
      await openMultiUnitWork();
      expect(screen.getByText("Intro paragraph.")).toBeDefined();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("ReaderPage vocabulary lookup", () => {
  async function selectAndLookup(): Promise<ReturnType<typeof userEvent.setup>> {
    const { container, user } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    await user.click(await screen.findByRole("button", { name: "Look up" }));

    return user;
  }

  it("opens the view-only panel with the definition and never creates a note", async () => {
    mockedLookupTerm.mockResolvedValue({
      entry: {
        headword: "intro",
        partsOfSpeech: [
          {
            partOfSpeech: "noun",
            senses: [{ definition: "an introduction", examples: ["a short intro"], synonyms: [] }]
          }
        ],
        pronunciations: [{ ipa: "/ˈɪntroʊ/" }],
        sources: ["From a source."]
      },
      found: true
    });

    await selectAndLookup();

    expect(await screen.findByText("an introduction")).toBeDefined();
    expect(screen.getByText("From a source.")).toBeDefined();
    expect(mockedLookupTerm).toHaveBeenCalledWith("Intro", "en");
    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
    expect(mockedCreateNote).not.toHaveBeenCalled();
  });

  it("shows an empty state when no definition is found", async () => {
    mockedLookupTerm.mockResolvedValue({ found: false });

    await selectAndLookup();

    expect(await screen.findByText("No definition found.")).toBeDefined();
  });

  it("shows an error state when the lookup request fails", async () => {
    mockedLookupTerm.mockRejectedValue(new Error("network"));

    await selectAndLookup();

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("routes a Chinese work's selection to the work's language", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [chineseWork] });
    mockedFetchWorkContent.mockResolvedValue(chineseContent);
    mockedFetchNoteTemplates.mockResolvedValue({ templates: threeTemplates });
    mockedLookupTerm.mockResolvedValue({
      entry: {
        headword: "你好",
        partsOfSpeech: [{ senses: [{ definition: "hello; hi", examples: [], synonyms: [] }] }],
        pronunciations: [{ ipa: "ni3 hao3" }],
        sources: ["Definitions from CC-CEDICT (CC BY-SA 4.0)."]
      },
      found: true
    });

    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);
    await user.click(await screen.findByRole("button", { name: "中文测试" }));
    const block = blockElement(container, "b-zh");

    selectText(block, "你好");
    fireEvent.mouseUp(block);
    await user.click(await screen.findByRole("button", { name: "Look up" }));

    expect(await screen.findByText("hello; hi")).toBeDefined();
    expect(mockedLookupTerm).toHaveBeenCalledWith("你好", "zh-CN");
  });

  it("dismisses the lookup panel when closed", async () => {
    mockedLookupTerm.mockResolvedValue({
      entry: {
        headword: "intro",
        partsOfSpeech: [
          { senses: [{ definition: "an introduction", examples: [], synonyms: [] }] }
        ],
        pronunciations: [],
        sources: []
      },
      found: true
    });

    const user = await selectAndLookup();
    await screen.findByText("an introduction");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByText("an introduction")).toBeNull();
  });
});

describe("ReaderPage unit reducers", () => {
  it("leaves a non-ready state unchanged when selecting a unit", () => {
    const state = { status: "loadingWorks" } as const;

    expect(applyUnitSelection(state, 2)).toBe(state);
    expect(applyUnitForBlock(state, "b-1")).toBe(state);
  });

  it("leaves a ready-but-not-viewing state unchanged", () => {
    const state = { reading: { status: "idle" }, status: "ready", works: [] } as const;

    expect(applyUnitSelection(state, 2)).toBe(state);
    expect(applyUnitForBlock(state, "b-1")).toBe(state);
  });

  it("reports no reading position for a non-viewing state", () => {
    expect(viewingPosition({ status: "loadingWorks" })).toBeUndefined();
    expect(
      viewingPosition({ reading: { status: "idle" }, status: "ready", works: [] })
    ).toBeUndefined();
  });
});

describe("ReaderPage reading position", () => {
  it("restores the saved reading unit and scroll offset when reopening a work", async () => {
    window.localStorage.setItem(
      readingPositionKey("work-1"),
      JSON.stringify({ scrollOffset: 320, unitEntryId: "u-2" })
    );
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);

    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Heading text")).toBeDefined();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 320);
  });

  it("opens the first unit when the saved unit no longer exists", async () => {
    window.localStorage.setItem(
      readingPositionKey("work-1"),
      JSON.stringify({ scrollOffset: 40, unitEntryId: "u-removed" })
    );
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);

    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("saves the current unit per work as the reader navigates", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();

    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const savedUnit = (): string =>
      JSON.parse(window.localStorage.getItem(readingPositionKey("work-1")) ?? "{}").unitEntryId;
    expect(savedUnit()).toBe("u-1");

    await user.click(
      within(screen.getByRole("navigation", { name: "目录" })).getByRole("button", {
        name: "Section Two"
      })
    );
    await screen.findByText("Heading text");

    expect(savedUnit()).toBe("u-2");
  });
});

const richContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "list",
          entryId: toEntryId("b-list"),
          mdast: {
            children: [
              {
                children: [
                  { children: [{ type: "text", value: "First force" }], type: "paragraph" }
                ],
                type: "listItem"
              },
              {
                children: [
                  { children: [{ type: "text", value: "Second force" }], type: "paragraph" }
                ],
                type: "listItem"
              }
            ],
            ordered: false,
            type: "list"
          },
          orderIndex: 0,
          plaintext: "First force\nSecond force"
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-inline"),
          mdast: {
            children: [
              { type: "text", value: "Run " },
              { type: "inlineCode", value: "pnpm validate" },
              { type: "text", value: " often." }
            ],
            type: "paragraph"
          },
          orderIndex: 1,
          plaintext: "Run pnpm validate often."
        },
        {
          blockType: "code",
          entryId: toEntryId("b-code"),
          mdast: { lang: "ts", type: "code", value: "const answer = 42;" },
          orderIndex: 2,
          plaintext: "const answer = 42;"
        },
        {
          blockType: "blockquote",
          entryId: toEntryId("b-quote"),
          mdast: {
            children: [{ children: [{ type: "text", value: "An epigraph." }], type: "paragraph" }],
            type: "blockquote"
          },
          orderIndex: 3,
          plaintext: "An epigraph."
        }
      ],
      entryId: toEntryId("u-rich"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

// A unit whose declared title duplicates its own first heading (the "title appears twice"
// front-matter problem).
const duplicateHeadingContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("b-h"),
          mdast: { children: [{ type: "text", value: "Chapter One" }], depth: 2, type: "heading" },
          orderIndex: 0,
          plaintext: "Chapter One"
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-body"),
          mdast: { children: [{ type: "text", value: "Body text." }], type: "paragraph" },
          orderIndex: 1,
          plaintext: "Body text."
        }
      ],
      entryId: toEntryId("u-dup"),
      orderIndex: 0,
      title: "Chapter One"
    }
  ],
  workEntryId: toEntryId("work-1")
};

describe("ReaderPage readability", () => {
  it("renders a list as a real list with items", async () => {
    mockedFetchWorkContent.mockResolvedValue(richContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);

    const article = await screen.findByRole("article", { name: "Reading" });
    const list = within(article).getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("First force")).toBeDefined();
  });

  it("renders fenced code as a pre/code block and inline code as code", async () => {
    mockedFetchWorkContent.mockResolvedValue(richContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    await screen.findByRole("article", { name: "Reading" });
    const pre = container.querySelector("pre code");
    expect(pre?.textContent).toContain("const answer = 42;");

    const inline = Array.from(container.querySelectorAll("code")).find(
      (code) => code.closest("pre") === null
    );
    expect(inline?.textContent).toBe("pnpm validate");
  });

  it("renders a blockquote as a quote", async () => {
    mockedFetchWorkContent.mockResolvedValue(richContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    await screen.findByRole("article", { name: "Reading" });
    expect(container.querySelector("blockquote")?.textContent).toContain("An epigraph.");
  });

  it("suppresses the unit eyebrow when it duplicates the first heading", async () => {
    mockedFetchWorkContent.mockResolvedValue(duplicateHeadingContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);

    const article = await screen.findByRole("article", { name: "Reading" });
    // Only the block heading remains; the duplicate eyebrow is gone.
    expect(within(article).getAllByRole("heading", { name: "Chapter One" })).toHaveLength(1);
    expect(article.querySelector(".readerUnitTitle")).toBeNull();
  });
});
