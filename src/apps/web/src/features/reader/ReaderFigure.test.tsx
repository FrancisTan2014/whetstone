// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../shared/ui/toast/ToastProvider";

function mockMatchMedia(matchers: Record<string, boolean> = {}): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    matches: matchers[query] ?? false,
    media: query,
    removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

function render(ui: React.ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    )
  });
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
vi.mock("../lookup/lookupApi", () => ({ lookupTerm: vi.fn() }));
vi.mock("./readingPositionApi", () => ({
  fetchReadingPosition: vi.fn(),
  saveReadingPosition: vi.fn()
}));

import { fetchNoteTemplates, fetchNotes } from "../notes/notesApi";
import { lookupTerm } from "../lookup/lookupApi";
import { fetchUnitContent, fetchWorks, fetchWorkStructure, locateBlockUnit } from "./readerApi";
import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";
import { ReaderPage } from "./ReaderPage";
import type { BlockDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkStructure = vi.mocked(fetchWorkStructure);
const mockedFetchUnitContent = vi.mocked(fetchUnitContent);
const mockedLocateBlockUnit = vi.mocked(locateBlockUnit);
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
  mockedFetchWorkStructure.mockResolvedValue({
    readingUnits: content.readingUnits.map((unit) => ({
      blockCount: (unit.docBlocks ?? []).length + unit.blocks.length,
      entryId: unit.entryId,
      orderIndex: unit.orderIndex
    })),
    workEntryId: content.workEntryId
  });
  mockedFetchUnitContent.mockImplementation(async (_workEntryId, unitEntryId) => {
    const unit = content.readingUnits.find((candidate) => candidate.entryId === unitEntryId);

    if (unit === undefined) {
      throw new Error(`no reading unit seeded for ${unitEntryId}`);
    }

    return unit;
  });

  return render(<ReaderPage initialWorkEntryId="work-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn(), writable: true });
  mockedFetchWorks.mockResolvedValue({ works: [work] });
  mockedLocateBlockUnit.mockResolvedValue(undefined);
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

    // Wait for the unit's blocks to render (the figure), not just the always-present header title.
    await screen.findByRole("figure");
    const image = container.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/images/solo999");
    expect(image.getAttribute("alt")).toBe("");
    expect(container.querySelector("figcaption")).toBeNull();
  });
});

// A PM-backed reading unit (#311 `doc_blocks`): the reader builds the figure from the PM `figure`
// node, reading the image's stored reference + alt and the `figureCaption` child — replacing the
// mdast render path while preserving the same `<figure>`/image/caption experience.
function pmFigureContent(
  image: { alt?: string; imageResourceId?: string } | undefined
): WorkContentDto {
  const imageAttrs: Record<string, unknown> = {};
  if (image?.imageResourceId !== undefined) {
    imageAttrs["imageResourceId"] = image.imageResourceId;
  }
  if (image?.alt !== undefined) {
    imageAttrs["alt"] = image.alt;
  }

  const caption =
    image === undefined
      ? []
      : [{ content: [{ text: "PM caption.", type: "text" }], type: "figureCaption" }];
  const node = {
    attrs: { id: "pm-fig-1" },
    content: [{ attrs: imageAttrs, type: "image" }, ...caption],
    type: "figure"
  };

  return {
    readingUnits: [
      {
        blocks: [],
        docBlocks: [{ entryId: toEntryId("pm-fig-1"), node, orderIndex: 0, type: "figure" }],
        entryId: toEntryId("u-1"),
        orderIndex: 0
      }
    ],
    workEntryId: toEntryId("work-1")
  };
}

describe("ReaderPage PM figure blocks", () => {
  it("renders a PM figure as a lazy image from /api/images/:id with its caption", async () => {
    renderReader(pmFigureContent({ alt: "A dot", imageResourceId: "abc123" }));

    const figure = (await screen.findByText("PM caption.")).closest("figure") as HTMLElement;
    const image = within(figure).getByRole("img");
    expect(image.getAttribute("src")).toBe("/api/images/abc123");
    expect(image.getAttribute("alt")).toBe("A dot");
    expect(image.getAttribute("loading")).toBe("lazy");
    // The figure block stamps its addressable id from the PM node.
    expect(figure.closest("[data-block-id]")?.getAttribute("data-block-id")).toBe("pm-fig-1");
  });

  it("degrades a PM figure to caption-only when the image fails to load", async () => {
    const { container } = renderReader(pmFigureContent({ imageResourceId: "abc123" }));

    await screen.findByText("PM caption.");
    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("PM caption.")).not.toBeNull();
  });

  it("renders a PM figure caption-only when the image carries no stored reference", async () => {
    const { container } = renderReader(pmFigureContent({ alt: "no ref" }));

    await screen.findByText("PM caption.");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an image-only PM figure with no caption", async () => {
    const { container } = renderReader(pmFigureContent(undefined));

    await screen.findByRole("figure");
    expect(container.querySelector("figcaption")).toBeNull();
  });
});

describe("ReaderPage figure image lightbox (#334)", () => {
  const captionedFigure = () =>
    figureContent({ alt: "A dot", imageResourceId: "abc123", plaintext: "The caption." });

  it("opens a centered lightbox with the enlarged image on click, without navigating (mdast)", async () => {
    const user = userEvent.setup();
    renderReader(captionedFigure());

    const trigger = await screen.findByRole("button", { name: "View larger: A dot" });
    const hashBefore = window.location.hash;
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "A dot" });
    const enlarged = dialog.querySelector("img.lightbox-image");
    expect(enlarged?.getAttribute("src")).toBe("/api/images/abc123");
    // The figure caption shows beneath the enlarged image (criterion 10).
    expect(within(dialog).getByText("The caption.")).toBeDefined();
    // View-only: no route change, no new page.
    expect(window.location.hash).toBe(hashBefore);
  });

  it("opens the lightbox for a PM figure too (shared ReaderFigure)", async () => {
    const user = userEvent.setup();
    renderReader(pmFigureContent({ alt: "A dot", imageResourceId: "abc123" }));

    await user.click(await screen.findByRole("button", { name: "View larger: A dot" }));

    const dialog = await screen.findByRole("dialog", { name: "A dot" });
    expect(dialog.querySelector("img.lightbox-image")?.getAttribute("src")).toBe(
      "/api/images/abc123"
    );
  });

  it("opens on keyboard Enter from the focused trigger", async () => {
    const user = userEvent.setup();
    renderReader(captionedFigure());

    const trigger = await screen.findByRole("button", { name: "View larger: A dot" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("dialog", { name: "A dot" })).toBeDefined();
  });

  it("labels an image-only figure trigger and dialog without alt text, and shows no caption", async () => {
    const user = userEvent.setup();
    renderReader(figureContent({ imageResourceId: "solo999", plaintext: "" }));

    const trigger = await screen.findByRole("button", { name: "View image larger" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Enlarged image" });
    expect(dialog.querySelector("img.lightbox-image")?.getAttribute("src")).toBe(
      "/api/images/solo999"
    );
    expect(dialog.querySelector(".lightbox-caption")).toBeNull();
  });

  it("closes on Escape and returns focus to the figure trigger", async () => {
    const user = userEvent.setup();
    renderReader(captionedFigure());

    const trigger = await screen.findByRole("button", { name: "View larger: A dot" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "A dot" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on the ✕ button and returns focus to the figure trigger", async () => {
    const user = userEvent.setup();
    renderReader(captionedFigure());

    const trigger = await screen.findByRole("button", { name: "View larger: A dot" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "A dot" });

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a backdrop click", async () => {
    const user = userEvent.setup();
    renderReader(captionedFigure());

    await user.click(await screen.findByRole("button", { name: "View larger: A dot" }));
    await screen.findByRole("dialog", { name: "A dot" });

    await user.click(document.querySelector(".lightbox-overlay") as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders no trigger for a caption-only figure", async () => {
    renderReader(figureContent({ plaintext: "Caption without image." }));

    await screen.findByText("Caption without image.");
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
  });

  it("renders no trigger once the image fails to load", async () => {
    const { container } = renderReader(captionedFigure());

    await screen.findByText("The caption.");
    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
  });

  it("opens the lightbox on a narrow-screen tap without toggling the reading chrome (criterion 6)", async () => {
    mockMatchMedia({ "(max-width: 55.999rem)": true });
    const user = userEvent.setup();
    const { container } = renderReader(captionedFigure());

    const trigger = await screen.findByRole("button", { name: "View larger: A dot" });
    const header = container.querySelector(".readingHeader") as HTMLElement;
    // On a narrow screen the chrome starts hidden; tapping the figure must not reveal it.
    expect(header.getAttribute("data-hidden")).toBe("true");

    await user.click(trigger);

    expect(await screen.findByRole("dialog", { name: "A dot" })).toBeDefined();
    expect(header.getAttribute("data-hidden")).toBe("true");
  });

  it("opens and closes under reduced motion (fade-only, no transform animation)", async () => {
    mockMatchMedia({ "(prefers-reduced-motion: reduce)": true });
    const user = userEvent.setup();
    renderReader(captionedFigure());

    const trigger = await screen.findByRole("button", { name: "View larger: A dot" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "A dot" })).toBeDefined();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
