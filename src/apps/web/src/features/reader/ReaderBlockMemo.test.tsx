// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteTemplateDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

import { ToastProvider } from "../../shared/ui/toast/ToastProvider";

// Count every block-content render. Each rendered block runs the mdast→React pipeline exactly
// once at mount; the regression this guards against is an interaction (toolbar / template switch
// / lookup) re-running it for the whole block list (#72: ~500ms handlers on a large chapter).
const blockContent = vi.hoisted(() => ({ renders: 0 }));

vi.mock("./mdastBlock", () => ({
  BlockContent: ({ node }: { node: { children?: { value?: string }[] } }): React.JSX.Element => {
    blockContent.renders += 1;
    return <p>{node.children?.[0]?.value}</p>;
  }
}));

vi.mock("./readerApi", () => ({
  fetchUnitContent: vi.fn(),
  fetchWorkAnchorIndex: vi.fn(),
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
vi.mock("../lookup/lookupApi", () => ({ lookupTerm: vi.fn() }));

import { fetchNoteTemplates, fetchNotes } from "../notes/notesApi";
import { lookupTerm } from "../lookup/lookupApi";
import {
  fetchUnitContent,
  fetchWorks,
  fetchWorkAnchorIndex,
  fetchWorkStructure,
  locateBlockUnit
} from "./readerApi";
import { ReaderPage } from "./ReaderPage";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkStructure = vi.mocked(fetchWorkStructure);
const mockedFetchWorkAnchorIndex = vi.mocked(fetchWorkAnchorIndex);
const mockedFetchUnitContent = vi.mocked(fetchUnitContent);
const mockedLocateBlockUnit = vi.mocked(locateBlockUnit);
const mockedFetchNoteTemplates = vi.mocked(fetchNoteTemplates);
const mockedFetchNotes = vi.mocked(fetchNotes);
const mockedLookupTerm = vi.mocked(lookupTerm);

const author = { id: toAuthorId("author-1"), name: "A. Writer" };

const work: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-1"),
    language: "en",
    title: "A Long Chapter",
    workType: "essay"
  }
};

const templates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [{ id: "meaning", label: "Meaning in this context", type: "long_text" }],
    id: "vocabulary",
    name: "Vocabulary"
  }
];

const blockCount = 50;

function bigChapter(): WorkContentDto {
  return {
    readingUnits: [
      {
        blocks: Array.from({ length: blockCount }, (_unused, index) => ({
          blockType: "paragraph" as const,
          entryId: toEntryId(`b-${index}`),
          mdast: {
            children: [{ type: "text" as const, value: `Block ${index} content` }],
            type: "paragraph" as const
          },
          orderIndex: index,
          plaintext: `Block ${index} content`
        })),
        entryId: toEntryId("u-1"),
        orderIndex: 0
      }
    ],
    workEntryId: toEntryId("work-1")
  };
}

function selectText(blockElement: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(blockElement, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode() as Text;
  const start = (node.textContent ?? "").indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
}

function render(ui: React.ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    )
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  blockContent.renders = 0;
  window.getSelection()?.removeAllRanges();
  mockedFetchWorks.mockResolvedValue({ works: [work] });
  const content = bigChapter();
  mockedFetchWorkStructure.mockResolvedValue({
    readingUnits: content.readingUnits.map((unit) => ({
      blockCount: unit.blocks.length,
      entryId: unit.entryId,
      orderIndex: unit.orderIndex
    })),
    workEntryId: content.workEntryId
  });
  mockedFetchWorkAnchorIndex.mockResolvedValue({
    anchors: [],
    workEntryId: content.workEntryId
  });
  mockedFetchUnitContent.mockImplementation(async (_workEntryId, unitEntryId) => {
    const unit = content.readingUnits.find((candidate) => candidate.entryId === unitEntryId);

    if (unit === undefined) {
      throw new Error(`no reading unit seeded for ${unitEntryId}`);
    }

    return unit;
  });
  mockedLocateBlockUnit.mockResolvedValue(undefined);
  mockedFetchNoteTemplates.mockResolvedValue({ templates });
  mockedFetchNotes.mockResolvedValue({ notes: [] });
  mockedLookupTerm.mockResolvedValue({ found: false });
});

afterEach(() => {
  cleanup();
});

describe("ReaderPage block memoization", () => {
  it("does not re-render the block list when an interaction opens the toolbar or opens lookup", async () => {
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    await screen.findByText("Block 0 content");

    // Every block ran the mdast pipeline exactly once at mount.
    expect(blockContent.renders).toBe(blockCount);
    const afterMount = blockContent.renders;

    // Open the selection toolbar (mouseup), then open lookup. Neither touches block data, so with
    // memoized blocks + stable props no block re-renders — the render count must stay flat.
    const block = container.querySelector('[data-block-id="b-0"]') as HTMLElement;
    selectText(block, "Block");
    fireEvent.mouseUp(block);
    await user.click(await screen.findByRole("button", { name: "Look up" }));
    await screen.findByText(/No definition found for/);

    expect(blockContent.renders).toBe(afterMount);
  });
});
