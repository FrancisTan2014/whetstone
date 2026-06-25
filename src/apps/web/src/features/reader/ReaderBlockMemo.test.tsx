// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteTemplateDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

import { ToastProvider } from "../../shared/ui/toast/ToastProvider";

// Count every react-markdown render. Each rendered block runs this pipeline exactly once at
// mount; the regression this guards against is an interaction (toolbar / template switch /
// lookup) re-running it for the whole block list (#72: ~500ms handlers on a large chapter).
const markdown = vi.hoisted(() => ({ renders: 0 }));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }): React.JSX.Element => {
    markdown.renders += 1;
    return <span>{children}</span>;
  }
}));

vi.mock("./readerApi", () => ({ fetchWorkContent: vi.fn(), fetchWorks: vi.fn() }));
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
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { ReaderPage } from "./ReaderPage";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkContent = vi.mocked(fetchWorkContent);
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
  markdown.renders = 0;
  window.getSelection()?.removeAllRanges();
  mockedFetchWorks.mockResolvedValue({ works: [work] });
  mockedFetchWorkContent.mockResolvedValue(bigChapter());
  mockedFetchNoteTemplates.mockResolvedValue({ templates });
  mockedFetchNotes.mockResolvedValue({ notes: [] });
  mockedLookupTerm.mockResolvedValue({ found: false });
});

afterEach(() => {
  cleanup();
});

describe("ReaderPage block memoization", () => {
  it("does not re-render the block list when an interaction opens the toolbar, switches a template, or opens lookup", async () => {
    const user = userEvent.setup();
    const { container } = render(<ReaderPage initialWorkEntryId="work-1" />);

    await screen.findByText("Block 0 content");

    // Every block ran the markdown pipeline exactly once at mount.
    expect(markdown.renders).toBe(blockCount);
    const afterMount = markdown.renders;

    // Open the selection toolbar (mouseup), switch the template, then open lookup. None of these
    // touch block data, so with memoized blocks + stable props no block re-renders — the
    // markdown render count must stay flat.
    const block = container.querySelector('[data-block-id="b-0"]') as HTMLElement;
    selectText(block, "Block");
    fireEvent.mouseUp(block);
    await user.click(await screen.findByRole("button", { name: "Vocabulary" }));
    await user.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("No definition found.");

    expect(markdown.renders).toBe(afterMount);
  });
});
