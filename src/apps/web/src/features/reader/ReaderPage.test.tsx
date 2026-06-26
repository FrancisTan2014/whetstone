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
  fetchUnitContent: vi.fn(),
  fetchWorkStructure: vi.fn(),
  fetchWorks: vi.fn(),
  locateBlockUnit: vi.fn()
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

vi.mock("./readingPositionApi", () => ({
  fetchReadingPosition: vi.fn(),
  saveReadingPosition: vi.fn()
}));

import {
  createNote,
  deleteNote,
  fetchNoteTemplates,
  fetchNotes,
  updateNote
} from "../notes/notesApi";
import { lookupTerm } from "../lookup/lookupApi";
import { fetchUnitContent, fetchWorks, fetchWorkStructure, locateBlockUnit } from "./readerApi";
import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";
import {
  applyUnitError,
  applyUnitForBlock,
  applyUnitLoaded,
  applyUnitSelection,
  ReaderPage,
  retryActiveUnit,
  viewingPosition
} from "./ReaderPage";
import type { ReaderBlock, ReaderStructure } from "./readerModel";
import type {
  NoteDto,
  NoteTemplateDto,
  WorkContentDto,
  WorkListDto,
  WorkListItemDto,
  WorkStructureDto
} from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkStructure = vi.mocked(fetchWorkStructure);
const mockedFetchUnitContent = vi.mocked(fetchUnitContent);
const mockedLocateBlockUnit = vi.mocked(locateBlockUnit);
const mockedFetchNoteTemplates = vi.mocked(fetchNoteTemplates);
const mockedCreateNote = vi.mocked(createNote);
const mockedFetchNotes = vi.mocked(fetchNotes);
const mockedUpdateNote = vi.mocked(updateNote);
const mockedDeleteNote = vi.mocked(deleteNote);
const mockedLookupTerm = vi.mocked(lookupTerm);
const mockedFetchReadingPosition = vi.mocked(fetchReadingPosition);
const mockedSaveReadingPosition = vi.mocked(saveReadingPosition);

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

// The reader now loads a work's lightweight structure first, then each active unit's blocks on
// demand. A single seeded `WorkContentDto` drives all three reader fetches: `fetchWorkStructure`
// returns its unit metadata, `fetchUnitContent` returns the matching unit's blocks (rejecting an
// unknown unit the way a 404 would), and `locateBlockUnit` resolves a block to its owning unit
// (or undefined when no unit holds it). Tests keep their existing `content` fixtures and just call
// `seedWorkContent(content)` instead of stubbing a whole-work fetch.
let seededContent: WorkContentDto = emptyContent("work-1");

function structureOf(content: WorkContentDto): WorkStructureDto {
  return {
    readingUnits: content.readingUnits.map((unit) => ({
      blockCount: unit.blocks.length,
      entryId: unit.entryId,
      orderIndex: unit.orderIndex,
      ...(unit.title === undefined ? {} : { title: unit.title })
    })),
    workEntryId: content.workEntryId
  };
}

function seedWorkContent(content: WorkContentDto): void {
  seededContent = content;
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

// Select inside a nested block (blockquote, list): walk to the text node that actually contains
// the phrase, since the block's first text node may be the rendered structural whitespace.
function selectTextDeep(blockElement: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(blockElement, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const start = (node.textContent ?? "").indexOf(text);

    if (start !== -1) {
      selectRangeIn(node, start, start + text.length);
      return;
    }
  }

  throw new Error(`text not found in block: ${text}`);
}

function blockElement(container: HTMLElement, blockId: string): HTMLElement {
  return container.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
}

// The 目录 is now a controlled drawer toggled from the receding ReadingHeader: open it from the
// header tool, then read the navigation it reveals.
async function openTocDrawer(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Table of contents" }));

  return screen.getByRole("navigation", { name: "目录" });
}

// "Your notes" is no longer pinned to the reading column; it lives in a Sheet opened from the
// header tool. Open it, then assert against the dialog it reveals.
async function openNotesPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Your notes" }));

  return screen.findByRole("dialog", { name: "Your notes" });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
  // jsdom does not implement scrollIntoView; the jump-back affordance calls it.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // jsdom does not implement scrollTo; keep it stubbed so any library scroll call is a no-op.
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn(), writable: true });
  mockedFetchWorks.mockResolvedValue({ works: [workA] });
  seededContent = emptyContent("work-1");
  mockedFetchWorkStructure.mockImplementation(async (workEntryId: string) => ({
    readingUnits: structureOf(seededContent).readingUnits,
    workEntryId: toEntryId(workEntryId)
  }));
  mockedFetchUnitContent.mockImplementation(async (_workEntryId: string, unitEntryId: string) => {
    const unit = seededContent.readingUnits.find((candidate) => candidate.entryId === unitEntryId);

    if (unit === undefined) {
      throw new Error(`no reading unit seeded for ${unitEntryId}`);
    }

    return unit;
  });
  mockedLocateBlockUnit.mockImplementation(
    async (_workEntryId: string, blockEntryId: string) =>
      seededContent.readingUnits.find((unit) =>
        unit.blocks.some((block) => block.entryId === blockEntryId)
      )?.entryId
  );
  mockedFetchNoteTemplates.mockResolvedValue({ templates: noteTemplates });
  mockedFetchNotes.mockResolvedValue({ notes: [] });
  // The server is the source of truth for reading position; default to "no saved position".
  mockedFetchReadingPosition.mockResolvedValue(undefined);
  mockedSaveReadingPosition.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("ReaderPage", () => {
  it("shows a loading state before works resolve", async () => {
    render(<ReaderPage />);

    expect(screen.getByText("Loading works…")).toBeDefined();
    await screen.findByText("Open a work from your Library");
  });

  it("shows an error when works fail to load", async () => {
    mockedFetchWorks.mockRejectedValue(new Error("network"));

    render(<ReaderPage />);

    expect(await screen.findByText("Could not load works.")).toBeDefined();
  });

  it("shows the empty state when no works exist", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [] });

    render(<ReaderPage />);

    expect(await screen.findByText("Open a work from your Library")).toBeDefined();
  });

  it("shows the empty state and a back-to-Library control when no work is open", async () => {
    render(<ReaderPage />);

    expect(await screen.findByText("Open a work from your Library")).toBeDefined();
    const back = screen.getByRole("link", { name: "Back to Library" });
    expect(back.getAttribute("href")).toBe("#/");
  });

  it("opens the requested work on arrival when given an initial work entry id", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    seedWorkContent(multiUnitContent);

    render(<ReaderPage initialWorkEntryId="work-2" />);

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(mockedFetchWorkStructure).toHaveBeenCalledWith("work-2");
  });

  it("ignores a superseded initial open torn down before works resolve", async () => {
    // React StrictMode (and rapid work switches) double-invoke the open effect; the cleanup must
    // stop a superseded run so it never opens the work after teardown — otherwise the stale run
    // could reset the active unit back to loading after the live run already loaded it.
    let resolveWorks: (value: WorkListDto) => void = () => {};
    mockedFetchWorks.mockReturnValue(
      new Promise<WorkListDto>((resolve) => {
        resolveWorks = resolve;
      })
    );
    seedWorkContent(multiUnitContent);

    const { unmount } = render(<ReaderPage initialWorkEntryId="work-1" />);
    unmount();
    resolveWorks({ works: [workA] });
    await Promise.resolve();
    await Promise.resolve();

    // The torn-down run does not proceed to open the work.
    expect(mockedFetchWorkStructure).not.toHaveBeenCalled();
  });

  it("opens the unit deep-linked by a block param and scrolls to that block", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(
      <ReaderPage initialBlockEntryId="b-2" initialWorkEntryId="work-1" />
    );

    // b-2 lives in the second unit, so the reader opens straight into that unit.
    expect(await screen.findByText("Heading text")).toBeDefined();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(blockElement(container, "b-2")?.scrollIntoView).toHaveBeenCalled();
  });

  it("shows the empty state when the initial work entry id is unknown", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });

    render(<ReaderPage initialWorkEntryId="missing-work" />);

    expect(await screen.findByText("Open a work from your Library")).toBeDefined();
    expect(mockedFetchWorkStructure).not.toHaveBeenCalled();
  });

  it("does not render an image even when a block's Markdown contains one", async () => {
    seedWorkContent(imageContent);

    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Visible caption text.")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders only the active reading unit and switches units via the 目录", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    // The first unit opens by default; the second unit's blocks are not mounted yet.
    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(screen.queryByRole("heading", { level: 2, name: "Heading text" })).toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
        element.getAttribute("data-block-id")
      )
    ).toEqual(["b-1"]);

    // Selecting the second unit in the 目录 swaps the rendered content.
    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();
    expect(container.querySelector("em")?.textContent).toBe("emphasized word");
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
        element.getAttribute("data-block-id")
      )
    ).toEqual(["b-2", "b-3"]);

    expect(mockedFetchWorkStructure).toHaveBeenCalledWith("work-1");
  });

  it("reads a single-unit work without a 目录", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [chineseWork] });
    seedWorkContent(chineseContent);
    render(<ReaderPage initialWorkEntryId="work-zh" />);

    expect(await screen.findByText("你好世界")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Table of contents" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "目录" })).toBeNull();
  });

  it("shows the untitled active unit without a heading", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    // The first unit is untitled, so the reading article renders no chapter heading.
    expect(
      within(screen.getByRole("article", { name: "Reading" })).queryAllByRole("heading", {
        level: 2
      })
    ).toHaveLength(0);

    // Switching to the titled unit shows its title heading plus its content heading.
    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));
    expect(
      within(await screen.findByRole("article", { name: "Reading" })).getAllByRole("heading", {
        level: 2
      })
    ).toHaveLength(2);
  });

  it("shows a loading state while a work's structure loads", async () => {
    let resolveStructure!: (value: WorkStructureDto) => void;
    mockedFetchWorkStructure.mockReturnValue(
      new Promise<WorkStructureDto>((resolve) => {
        resolveStructure = resolve;
      })
    );
    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Loading the work…")).toBeDefined();

    resolveStructure({ readingUnits: [], workEntryId: toEntryId("work-1") });

    expect(await screen.findByText("This work has no content yet.")).toBeDefined();
  });

  it("shows an error when a work's structure fails to load", async () => {
    mockedFetchWorkStructure.mockRejectedValue(new Error("boom"));
    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Could not load this work. Please try again.")).toBeDefined();
  });

  it("shows a message when an opened work has no content", async () => {
    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("This work has no content yet.")).toBeDefined();
  });

  it("renders Markdown safely and does not execute raw HTML", async () => {
    seedWorkContent(unsafeContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByRole("heading", { level: 1, name: "Safe heading" })).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("__xssReader");
  });

  it("renders in-content links as non-navigating text that stays selectable", async () => {
    seedWorkContent(linkContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
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
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    await user.click(await screen.findByRole("button", { name: "Add note" }));

    expect(await screen.findByRole("heading", { name: "New note" })).toBeDefined();
    expect(screen.getByText(/Selected: Intro/)).toBeDefined();
  });

  it("suppresses the context menu and callout in the reading area while keeping text selectable", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    // Right-click in the reading area does not open the browser context menu (default prevented).
    const reading = screen.getByRole("article", { name: "Reading" });
    expect(fireEvent.contextMenu(reading)).toBe(false);
    // The reading surface carries the callout/user-select styling hook.
    expect(reading.className).toContain("reader");

    // Text is still selectable for lookup/annotation — the selection toolbar still appears.
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    expect(await screen.findByRole("button", { name: "Add note" })).toBeDefined();
  });

  it("anchors a note to the selected occurrence of repeated text", async () => {
    seedWorkContent(repeatedContent);
    mockedCreateNote.mockResolvedValue({ entryId: "note-1" } as unknown as NoteDto);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
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
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(blockElement(container, "b-1"));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("does not open the toolbar for a whitespace-only selection", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    const block = await screen.findByText("Intro paragraph.");
    // "Intro paragraph." has a space at index 5.
    selectRangeIn(firstTextNode(block as HTMLElement), 5, 6);
    fireEvent.mouseUp(blockElement(container, "b-1"));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("confirms and closes the editor after a note is saved", async () => {
    seedWorkContent(multiUnitContent);
    mockedCreateNote.mockResolvedValue({ entryId: "note-1" } as unknown as NoteDto);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
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
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");
    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("closes the editor when cancelled", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
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
    seedWorkContent(multiUnitContent);
    mockedFetchNoteTemplates.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
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
  seedWorkContent(multiUnitContent);
  mockedFetchNoteTemplates.mockResolvedValue({ templates: threeTemplates });
  const user = userEvent.setup();
  const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

  await screen.findByText("Intro paragraph.");

  return { container, user };
}

describe("ReaderPage selection toolbar", () => {
  it("shows only the two primary actions, not inline template buttons", async () => {
    const { container } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.mouseUp(block);

    await screen.findByRole("toolbar", { name: "Annotate selection" });
    expect(screen.getByRole("button", { name: "Add note" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Look up" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Vocabulary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expression" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thought" })).toBeNull();
  });

  it("preselects the size-based template in the editor (one word picks Vocabulary)", async () => {
    const { container, user } = await openHuedReader();
    const block = blockElement(container, "b-1");

    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    await user.click(await screen.findByRole("button", { name: "Add note" }));

    await screen.findByRole("heading", { name: "New note" });
    expect(screen.getByRole("button", { name: "Vocabulary" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Expression" }).getAttribute("aria-pressed")).toBe(
      "false"
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
  seedWorkContent(multiUnitContent);
  mockedFetchNotes.mockResolvedValue({ notes });
  const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

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
    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));
    await screen.findByText("Heading text");
    const plain = blockElement(container, "b-2");
    expect(plain.getAttribute("data-has-notes")).toBeNull();
    expect(plain.className).not.toContain("readerBlock--annotated");
  });

  it("lists a per-work note with its anchored snippet", async () => {
    await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();

    const panel = await openNotesPanel(user);
    expect(within(panel).getByText(/Intro/)).toBeDefined();
    expect(within(panel).getByText("the beginning")).toBeDefined();
  });

  it("reopens a block's notes from its highlight and edits one", async () => {
    seedWorkContent(multiUnitContent);
    mockedFetchNotes.mockResolvedValueOnce({ notes: [makeNote()] });
    const updated = makeNote({ answers: { meaning: "a fresh start" } });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [updated] });
    mockedUpdateNote.mockResolvedValue(updated);
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
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
    seedWorkContent(multiUnitContent);
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
    render(<ReaderPage initialWorkEntryId="work-1" />);
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
    seedWorkContent(multiUnitContent);
    mockedFetchNotes.mockResolvedValueOnce({ notes: [makeNote()] });
    const updated = makeNote({ answers: { meaning: "edited" } });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [updated] });
    mockedUpdateNote.mockResolvedValue(updated);
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Edit note: Intro" }));

    expect(await screen.findByRole("heading", { name: "Edit note" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(mockedUpdateNote).toHaveBeenCalledWith("work-1", "note-1", {
      answers: { meaning: "the beginning" },
      templateId: "vocabulary"
    });
  });

  it("deletes a note from the per-work note list", async () => {
    seedWorkContent(multiUnitContent);
    mockedFetchNotes.mockResolvedValueOnce({ notes: [makeNote()] });
    mockedFetchNotes.mockResolvedValueOnce({ notes: [] });
    mockedDeleteNote.mockResolvedValue();
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Delete note: Intro" }));

    expect(await screen.findByText("Note deleted.")).toBeDefined();
    expect(mockedDeleteNote).toHaveBeenCalledWith("work-1", "note-1");
    expect(screen.getByText("No notes yet. Select text in the reader to add one.")).toBeDefined();
  });

  it("shows an error when deleting a note fails", async () => {
    seedWorkContent(multiUnitContent);
    mockedFetchNotes.mockResolvedValue({ notes: [makeNote()] });
    mockedDeleteNote.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Delete note: Intro" }));

    expect(await screen.findByText("Could not delete the note. Please try again.")).toBeDefined();
  });

  it("jumps back to the annotated block from a per-work note card", async () => {
    const container = await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Jump to text: Intro" }));

    // Jumping dismisses the notes panel and scrolls the annotated block back into view. (Focus
    // landing on the block is covered by the non-dialog block-notes jump below, which is not
    // subject to the Sheet's async focus restoration.)
    expect(screen.queryByRole("dialog", { name: "Your notes" })).toBeNull();
    expect(blockElement(container, "b-1").scrollIntoView).toHaveBeenCalled();
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

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Jump to text: Heading" }));

    const target = await screen.findByText("Heading text");
    expect(blockElement(container, "b-2")).not.toBeNull();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(target.closest("[data-block-id]")?.scrollIntoView).toHaveBeenCalled();
  });
});

describe("ReaderPage reading tools", () => {
  it("opens the notes panel from the header tool and closes it again", async () => {
    await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();

    const panel = await openNotesPanel(user);
    expect(within(panel).getByText(/Intro/)).toBeDefined();

    await user.click(within(panel).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog", { name: "Your notes" })).toBeNull();
  });

  it("labels the notes tool with the note count", async () => {
    await openWorkWithNotes([makeNote()]);

    expect(screen.getByRole("button", { name: "Your notes" }).textContent).toContain("1");
  });

  it("shows the notes tool with no count when there are no notes", async () => {
    seedWorkContent(multiUnitContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const notes = screen.getByRole("button", { name: "Your notes" });
    expect(notes.querySelector(".readingToolBadge")).toBeNull();
  });

  it("offers the Day/Night theme toggle among the reading tools", async () => {
    seedWorkContent(multiUnitContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    expect(screen.getByRole("button", { name: "Switch to Night" })).toBeDefined();
  });

  it("closes the 目录 drawer after a unit is selected", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));

    await screen.findByText("Heading text");
    expect(screen.queryByRole("navigation", { name: "目录" })).toBeNull();
  });

  it("dismisses the 目录 drawer from its backdrop", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    await openTocDrawer(user);
    await user.click(screen.getByRole("button", { name: "Close table of contents" }));

    expect(screen.queryByRole("navigation", { name: "目录" })).toBeNull();
  });
});

describe("ReaderPage reading controls", () => {
  async function openMultiUnitWork(): Promise<HTMLElement> {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
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

  it("keeps the reading column width stable (font-size-independent) when the text size changes", async () => {
    const user = userEvent.setup();
    const container = await openMultiUnitWork();
    const surface = surfaceIn(container);
    // A font-size-independent rem measure: the column width never tracks --reading-size.
    const measureAtDefault = surface.style.getPropertyValue("--reading-measure");
    expect(measureAtDefault).toBe("37rem");

    await user.click(screen.getByRole("button", { name: "Increase reading text size" }));

    // The text grew, but the column measure is unchanged — the text reflows within it.
    expect(surface.style.getPropertyValue("--reading-size")).toBe("1.3125rem");
    expect(surface.style.getPropertyValue("--reading-measure")).toBe(measureAtDefault);
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

  function mockNarrowViewport(): () => void {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }

  it("on a narrow screen hides the chrome by default and toggles it with a center tap", async () => {
    const user = userEvent.setup();
    const restore = mockNarrowViewport();
    try {
      const container = await openMultiUnitWork();
      const header = (): HTMLElement => container.querySelector(".readingHeader") as HTMLElement;

      // Mobile chrome is hidden by default.
      expect(header().getAttribute("data-hidden")).toBe("true");

      // A center tap on the reading text (no selection, not a control) reveals the chrome…
      await user.click(screen.getByText("Intro paragraph."));
      expect(header().getAttribute("data-hidden")).toBeNull();

      // …and tapping again hides it.
      await user.click(screen.getByText("Intro paragraph."));
      expect(header().getAttribute("data-hidden")).toBe("true");
    } finally {
      restore();
    }
  });

  it("does not toggle the chrome on a tap that completes a text selection", async () => {
    const restore = mockNarrowViewport();
    try {
      const container = await openMultiUnitWork();
      const header = (): HTMLElement => container.querySelector(".readingHeader") as HTMLElement;
      expect(header().getAttribute("data-hidden")).toBe("true");

      const paragraph = screen.getByText("Intro paragraph.");
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.isCollapsed).toBe(false);

      // A click that ends a selection is a selection gesture, not a chrome toggle.
      fireEvent.click(paragraph);
      expect(header().getAttribute("data-hidden")).toBe("true");
    } finally {
      restore();
    }
  });

  it("does not toggle the chrome when a tap lands on a reading tool", async () => {
    const user = userEvent.setup();
    const restore = mockNarrowViewport();
    try {
      const container = await openMultiUnitWork();
      const header = (): HTMLElement => container.querySelector(".readingHeader") as HTMLElement;

      // Reveal the chrome, then tap a tool: the tool acts, but the chrome stays put.
      await user.click(screen.getByText("Intro paragraph."));
      expect(header().getAttribute("data-hidden")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Increase reading text size" }));
      expect(header().getAttribute("data-hidden")).toBeNull();
    } finally {
      restore();
    }
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
    seedWorkContent(chineseContent);
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
    const { container } = render(<ReaderPage initialWorkEntryId="work-zh" />);
    await screen.findByText("你好世界");
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
    expect(applyUnitForBlock(state, "u-1", "b-1")).toBe(state);
  });

  it("leaves a ready-but-not-viewing state unchanged", () => {
    const state = { reading: { status: "idle" }, status: "ready", works: [] } as const;

    expect(applyUnitSelection(state, 2)).toBe(state);
    expect(applyUnitForBlock(state, "u-1", "b-1")).toBe(state);
  });

  it("reports no reading position for a non-viewing state", () => {
    expect(viewingPosition({ status: "loadingWorks" })).toBeUndefined();
    expect(
      viewingPosition({ reading: { status: "idle" }, status: "ready", works: [] })
    ).toBeUndefined();
  });

  it("leaves a non-viewing state unchanged for the load/error/retry reducers", () => {
    const state = { status: "loadingWorks" } as const;

    expect(applyUnitLoaded(state, "u-1", [])).toBe(state);
    expect(applyUnitError(state, "u-1")).toBe(state);
    expect(retryActiveUnit(state)).toBe(state);
  });
});

describe("ReaderPage unit reducers (viewing)", () => {
  const reducerStructure: ReaderStructure = {
    units: [
      { blockCount: 1, entryId: "u-1", orderIndex: 0 },
      { blockCount: 2, entryId: "u-2", orderIndex: 1, title: "Two" }
    ],
    workEntryId: "work-1"
  };

  const block: ReaderBlock = {
    blockType: "paragraph",
    entryId: "b-2",
    isHeading: false,
    mdast: { type: "text", value: "x" },
    plaintext: "x"
  };

  type ReaderTestState = Parameters<typeof applyUnitSelection>[0];
  type ViewingReading = Extract<
    Extract<ReaderTestState, { status: "ready" }>["reading"],
    { status: "viewing" }
  >;

  function viewing(overrides: Partial<ViewingReading> = {}): ReaderTestState {
    return {
      reading: {
        activeUnit: { status: "loading" },
        activeUnitIndex: 0,
        loadNonce: 0,
        status: "viewing",
        structure: reducerStructure,
        workEntryId: "work-1",
        ...overrides
      },
      status: "ready",
      works: []
    };
  }

  function asViewing(state: ReaderTestState): ViewingReading {
    if (state.status !== "ready" || state.reading.status !== "viewing") {
      throw new Error("expected a viewing state");
    }

    return state.reading;
  }

  it("clears the scroll target when re-selecting the open unit", () => {
    const reselected = asViewing(applyUnitSelection(viewing({ scrollBlockEntryId: "b-1" }), 0));

    expect(reselected.activeUnitIndex).toBe(0);
    expect(reselected.scrollBlockEntryId).toBeUndefined();
    expect(reselected.loadNonce).toBe(0);
  });

  it("clamps an out-of-range TOC selection into the last unit", () => {
    const clamped = asViewing(applyUnitSelection(viewing(), 9));

    expect(clamped.activeUnitIndex).toBe(1);
    expect(clamped.loadNonce).toBe(1);
  });

  it("moves to a different selected unit with a fresh load", () => {
    const moved = asViewing(applyUnitSelection(viewing(), 1));

    expect(moved.activeUnitIndex).toBe(1);
    expect(moved.activeUnit.status).toBe("loading");
    expect(moved.loadNonce).toBe(1);
    expect(moved.scrollBlockEntryId).toBeUndefined();
  });

  it("ignores a jump whose unit is not in the structure", () => {
    const state = viewing();

    expect(applyUnitForBlock(state, "u-gone", "b-x")).toBe(state);
  });

  it("sets only the scroll target for a same-unit jump", () => {
    const jumped = asViewing(applyUnitForBlock(viewing(), "u-1", "b-1"));

    expect(jumped.activeUnitIndex).toBe(0);
    expect(jumped.scrollBlockEntryId).toBe("b-1");
    expect(jumped.loadNonce).toBe(0);
  });

  it("moves to the holding unit and scrolls for a cross-unit jump", () => {
    const jumped = asViewing(applyUnitForBlock(viewing(), "u-2", "b-2"));

    expect(jumped.activeUnitIndex).toBe(1);
    expect(jumped.activeUnit.status).toBe("loading");
    expect(jumped.scrollBlockEntryId).toBe("b-2");
    expect(jumped.loadNonce).toBe(1);
  });

  it("marks the active unit loaded with its blocks and structure title", () => {
    const loaded = asViewing(applyUnitLoaded(viewing({ activeUnitIndex: 1 }), "u-2", [block]));

    expect(loaded.activeUnit).toEqual({
      status: "loaded",
      unit: { blocks: [block], entryId: "u-2", title: "Two" }
    });
  });

  it("ignores a loaded result for a unit that is no longer active", () => {
    const state = viewing();

    expect(applyUnitLoaded(state, "u-2", [block])).toBe(state);
  });

  it("marks the active unit errored", () => {
    const errored = asViewing(applyUnitError(viewing(), "u-1"));

    expect(errored.activeUnit.status).toBe("error");
  });

  it("ignores an error for a unit that is no longer active", () => {
    const state = viewing();

    expect(applyUnitError(state, "u-2")).toBe(state);
  });

  it("retries the active unit by reloading and bumping the load nonce", () => {
    const retried = asViewing(retryActiveUnit(viewing({ activeUnit: { status: "error" } })));

    expect(retried.activeUnit.status).toBe("loading");
    expect(retried.loadNonce).toBe(1);
  });

  it("reads the active unit's work and unit ids as the reading position", () => {
    expect(viewingPosition(viewing({ activeUnitIndex: 1 }))).toEqual({
      unitEntryId: "u-2",
      workEntryId: "work-1"
    });
  });

  it("reports no reading position when the active index is out of range", () => {
    expect(viewingPosition(viewing({ activeUnitIndex: 5 }))).toBeUndefined();
  });
});

describe("ReaderPage reading position", () => {
  it("resumes the saved unit and scrolls to its block anchor when reopening a work", async () => {
    mockedFetchReadingPosition.mockResolvedValue({ anchorBlockEntryId: "b-2", unitEntryId: "u-2" });
    seedWorkContent(multiUnitContent);

    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Heading text")).toBeDefined();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(mockedFetchReadingPosition).toHaveBeenCalledWith("work-1");
    expect(blockElement(container, "b-2").scrollIntoView).toHaveBeenCalled();
  });

  it("does not overwrite the saved block anchor with a pre-scroll save when reopening", async () => {
    // The saved anchor (b-3) is NOT the top of its unit (u-2's top block is b-2), so a save taken
    // before the restore scroll would capture b-2 and clobber b-3. The writer must stay suppressed
    // until the scroll lands, so opening writes nothing.
    mockedFetchReadingPosition.mockResolvedValue({ anchorBlockEntryId: "b-3", unitEntryId: "u-2" });
    seedWorkContent(multiUnitContent);

    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Heading text")).toBeDefined();
    expect(blockElement(container, "b-3").scrollIntoView).toHaveBeenCalled();
    expect(mockedSaveReadingPosition).not.toHaveBeenCalled();
  });

  it("opens the first unit when the saved unit no longer exists", async () => {
    mockedFetchReadingPosition.mockResolvedValue({ unitEntryId: "u-removed" });
    seedWorkContent(multiUnitContent);

    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(blockElement(container, "b-1").scrollIntoView).not.toHaveBeenCalled();
  });

  it("opens the first unit when the position fetch fails (offline) without error", async () => {
    mockedFetchReadingPosition.mockRejectedValue(new Error("offline"));
    seedWorkContent(multiUnitContent);

    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
  });

  it("saves the current unit per work to the server as the reader navigates", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();

    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const lastSavedUnit = (): string | undefined =>
      mockedSaveReadingPosition.mock.calls.at(-1)?.[1].unitEntryId;
    expect(mockedSaveReadingPosition).toHaveBeenCalledWith("work-1", { unitEntryId: "u-1" });
    expect(lastSavedUnit()).toBe("u-1");

    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));
    await screen.findByText("Heading text");

    expect(lastSavedUnit()).toBe("u-2");
  });
});

describe("ReaderPage lazy unit loading", () => {
  it("shows a per-section loading indicator while the active unit's blocks load", async () => {
    seedWorkContent(multiUnitContent);
    let resolveUnit!: (value: WorkContentDto["readingUnits"][number]) => void;
    mockedFetchUnitContent.mockReturnValueOnce(
      new Promise<WorkContentDto["readingUnits"][number]>((resolve) => {
        resolveUnit = resolve;
      })
    );

    render(<ReaderPage initialWorkEntryId="work-1" />);

    // The work's structure has resolved, but the first unit's blocks are still in flight.
    expect(await screen.findByText("Loading this section…")).toBeDefined();

    resolveUnit(multiUnitContent.readingUnits[1]!);

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(screen.queryByText("Loading this section…")).toBeNull();
  });

  it("shows an error with Retry when a unit fails to load, and recovers on Retry", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    mockedFetchUnitContent.mockRejectedValueOnce(new Error("offline"));

    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Could not load this section. Please try again.")).toBeDefined();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();

    // Retry refetches the same unit; the second attempt uses the seeded content and succeeds.
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(screen.queryByText("Could not load this section. Please try again.")).toBeNull();
  });

  it("ignores a jump to a note whose block can no longer be located", async () => {
    const goneNote = makeNote({
      anchor: {
        blockEntryId: toEntryId("b-gone"),
        contextSnapshot: "Intro paragraph.",
        selectedTextSnapshot: "Intro"
      },
      blockEntryId: toEntryId("b-gone")
    });
    const container = await openWorkWithNotes([goneNote]);
    const user = userEvent.setup();
    // The locator cannot resolve the removed block, so the jump must no-op.
    mockedLocateBlockUnit.mockResolvedValue(undefined);

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Jump to text: Intro" }));

    // Still on the first unit; no crash, the panel just closed.
    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(blockElement(container, "b-1").scrollIntoView).not.toHaveBeenCalled();
  });

  it("ignores a jump to a note when the locator request fails", async () => {
    const container = await openWorkWithNotes([makeNote()]);
    const user = userEvent.setup();
    mockedLocateBlockUnit.mockRejectedValue(new Error("offline"));

    const panel = await openNotesPanel(user);
    await user.click(within(panel).getByRole("button", { name: "Jump to text: Intro" }));

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(blockElement(container, "b-1").scrollIntoView).not.toHaveBeenCalled();
  });

  it("ignores a stale unit fetch that resolves after the reader switched units", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    let resolveStale!: (value: WorkContentDto["readingUnits"][number]) => void;
    // The first unit's fetch stays in flight so we can resolve it after switching away.
    mockedFetchUnitContent.mockReturnValueOnce(
      new Promise<WorkContentDto["readingUnits"][number]>((resolve) => {
        resolveStale = resolve;
      })
    );

    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Loading this section…")).toBeDefined();

    // Switch to the second unit while the first is still loading; its fetch resolves normally.
    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();

    // The stale first-unit fetch now resolves, but its race guard must drop the result.
    resolveStale(multiUnitContent.readingUnits[1]!);
    await Promise.resolve();

    expect(
      Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
        element.getAttribute("data-block-id")
      )
    ).toEqual(["b-2", "b-3"]);
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
  });

  it("ignores a stale unit fetch that rejects after the reader switched units", async () => {
    seedWorkContent(multiUnitContent);
    const user = userEvent.setup();
    let rejectStale!: (reason: Error) => void;
    mockedFetchUnitContent.mockReturnValueOnce(
      new Promise<WorkContentDto["readingUnits"][number]>((_resolve, reject) => {
        rejectStale = reject;
      })
    );

    render(<ReaderPage initialWorkEntryId="work-1" />);

    expect(await screen.findByText("Loading this section…")).toBeDefined();

    const toc = await openTocDrawer(user);
    await user.click(within(toc).getByRole("button", { name: "Section Two" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();

    // The stale first-unit fetch now rejects, but its race guard must suppress the error state.
    rejectStale(new Error("offline"));
    await Promise.resolve();

    expect(screen.queryByText("Could not load this section. Please try again.")).toBeNull();
    expect(await screen.findByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();
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
    seedWorkContent(richContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);

    const article = await screen.findByRole("article", { name: "Reading" });
    const list = within(article).getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("First force")).toBeDefined();
  });

  it("renders fenced code as a pre/code block and inline code as code", async () => {
    seedWorkContent(richContent);
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
    seedWorkContent(richContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    await screen.findByRole("article", { name: "Reading" });
    expect(container.querySelector("blockquote")?.textContent).toContain("An epigraph.");
  });

  it("suppresses the unit eyebrow when it duplicates the first heading", async () => {
    seedWorkContent(duplicateHeadingContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);

    const article = await screen.findByRole("article", { name: "Reading" });
    // Only the block heading remains; the duplicate eyebrow is gone.
    expect(within(article).getAllByRole("heading", { name: "Chapter One" })).toHaveLength(1);
    expect(article.querySelector(".readerUnitTitle")).toBeNull();
  });
});

describe("ReaderPage selection toolbar lifecycle", () => {
  it("opens the toolbar for a selection inside a blockquote", async () => {
    seedWorkContent(richContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByRole("article", { name: "Reading" });

    const quote = blockElement(container, "b-quote");
    selectTextDeep(quote, "epigraph");
    fireEvent.mouseUp(quote);

    expect(await screen.findByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });

  it("opens the toolbar for a selection inside a list item", async () => {
    seedWorkContent(richContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByRole("article", { name: "Reading" });

    const list = blockElement(container, "b-list");
    selectTextDeep(list, "Second force");
    fireEvent.mouseUp(list);

    expect(await screen.findByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });

  it("opens the toolbar even when the pointer is released outside the block", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    selectText(blockElement(container, "b-1"), "Intro");
    // Release on the reading column itself, not on the block element.
    fireEvent.mouseUp(screen.getByRole("article", { name: "Reading" }));

    expect(await screen.findByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });

  it("does not capture a release outside the reading column", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    selectText(blockElement(container, "b-1"), "Intro");
    fireEvent.mouseUp(document.body);

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("does not capture a release in the reading column without a selection", async () => {
    seedWorkContent(multiUnitContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(screen.getByRole("article", { name: "Reading" }));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("ignores a release whose selected block is not part of the active unit", async () => {
    seedWorkContent(multiUnitContent);
    render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const reading = screen.getByRole("article", { name: "Reading" });
    // A stray block-like element that is not one of the rendered unit's blocks.
    const stray = document.createElement("div");
    stray.setAttribute("data-block-id", "not-a-real-block");
    stray.textContent = "Ghost text";
    reading.appendChild(stray);
    selectRangeIn(stray.firstChild as Node, 0, 5);
    fireEvent.mouseUp(reading);

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("dismisses the toolbar when pressing outside it", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    await screen.findByRole("toolbar", { name: "Annotate selection" });

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });

  it("keeps the toolbar open when pressing inside it", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    const toolbar = await screen.findByRole("toolbar", { name: "Annotate selection" });

    fireEvent.mouseDown(toolbar);

    expect(screen.getByRole("toolbar", { name: "Annotate selection" })).toBeDefined();
  });

  it("dismisses the toolbar when the selection is cleared", async () => {
    seedWorkContent(multiUnitContent);
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);
    await screen.findByText("Intro paragraph.");

    const block = blockElement(container, "b-1");
    selectText(block, "Intro");
    fireEvent.mouseUp(block);
    await screen.findByRole("toolbar", { name: "Annotate selection" });

    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));

    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
  });
});
