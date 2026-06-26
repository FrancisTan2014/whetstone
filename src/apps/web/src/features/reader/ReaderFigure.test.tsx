// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../shared/ui/toast/ToastProvider";

function render(ui: React.ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    )
  });
}

vi.mock("./readerApi", () => ({ fetchWorkContent: vi.fn(), fetchWorks: vi.fn() }));
vi.mock("../notes/notesApi", () => ({
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  fetchNoteTemplates: vi.fn(),
  fetchNotes: vi.fn(),
  updateNote: vi.fn()
}));
vi.mock("../lookup/lookupApi", () => ({ lookupTerm: vi.fn() }));
vi.mock("./readingPositionApi", () => ({
  fetchReadingPosition: vi.fn(),
  saveReadingPosition: vi.fn()
}));

import { fetchNoteTemplates, fetchNotes } from "../notes/notesApi";
import { lookupTerm } from "../lookup/lookupApi";
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";
import { ReaderPage } from "./ReaderPage";
import type { BlockDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkContent = vi.mocked(fetchWorkContent);
const mockedFetchNoteTemplates = vi.mocked(fetchNoteTemplates);
const mockedFetchNotes = vi.mocked(fetchNotes);
const mockedLookupTerm = vi.mocked(lookupTerm);
const mockedFetchReadingPosition = vi.mocked(fetchReadingPosition);
const mockedSaveReadingPosition = vi.mocked(saveReadingPosition);

const author = { id: toAuthorId("author-1"), name: "A. Writer" };

const work: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-1"),
    language: "en",
    title: "Illustrated",
    workType: "book"
  }
};

function captionMdast(text: string): unknown {
  return { children: [{ type: "text", value: text }], type: "paragraph" };
}

function figureContent(figure: Partial<BlockDto> & Pick<BlockDto, "plaintext">): WorkContentDto {
  const block = {
    blockType: "figure",
    entryId: toEntryId("fig-1"),
    mdast: captionMdast(figure.plaintext),
    orderIndex: 0,
    ...figure
  } as BlockDto;

  return {
    readingUnits: [{ blocks: [block], entryId: toEntryId("u-1"), orderIndex: 0 }],
    workEntryId: toEntryId("work-1")
  };
}

function renderReader(content: WorkContentDto): ReturnType<typeof rtlRender> {
  mockedFetchWorkContent.mockResolvedValue(content);

  return render(<ReaderPage initialWorkEntryId="work-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn(), writable: true });
  mockedFetchWorks.mockResolvedValue({ works: [work] });
  mockedFetchNoteTemplates.mockResolvedValue({ templates: [] });
  mockedFetchNotes.mockResolvedValue({ notes: [] });
  mockedLookupTerm.mockResolvedValue({ found: false });
  mockedFetchReadingPosition.mockResolvedValue(undefined);
  mockedSaveReadingPosition.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("ReaderPage figure blocks", () => {
  it("renders a figure as a lazy image from /api/images/:id with its caption", async () => {
    renderReader(
      figureContent({ alt: "A dot", imageResourceId: "abc123", plaintext: "The caption." })
    );

    const figure = (await screen.findByText("The caption.")).closest("figure") as HTMLElement;
    const image = within(figure).getByRole("img");
    expect(image.getAttribute("src")).toBe("/api/images/abc123");
    expect(image.getAttribute("alt")).toBe("A dot");
    expect(image.getAttribute("loading")).toBe("lazy");
  });

  it("degrades to caption-only when the image fails to load at runtime", async () => {
    const { container } = renderReader(
      figureContent({ alt: "A dot", imageResourceId: "abc123", plaintext: "The caption." })
    );

    await screen.findByText("The caption.");
    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("The caption.")).not.toBeNull();
  });

  it("renders caption-only when there is no stored image", async () => {
    const { container } = renderReader(figureContent({ plaintext: "Caption without image." }));

    await screen.findByText("Caption without image.");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an image-only figure with no caption", async () => {
    const { container } = renderReader(
      figureContent({ imageResourceId: "solo999", plaintext: "" })
    );

    await screen.findByText("Illustrated");
    const image = container.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/images/solo999");
    expect(image.getAttribute("alt")).toBe("");
    expect(container.querySelector("figcaption")).toBeNull();
  });
});
