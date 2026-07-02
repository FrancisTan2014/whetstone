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

// jsdom lacks PointerEvent, and its fallback event carries neither clientX/clientY nor pointerId. A
// MouseEvent supplies the coordinates and we stamp the pointerId, so React's synthetic pointer handlers
// receive real values (the viewer's pinch/pan math is what we assert, not jsdom's absent layout).
function firePointer(
  node: HTMLElement,
  type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; clientY: number; pointerId: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(node, event);
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
vi.mock("./readingPositionApi", () => ({
  fetchReadingPosition: vi.fn(),
  saveReadingPosition: vi.fn()
}));

import { fetchNoteTemplates, fetchNotes } from "../notes/notesApi";
import { lookupTerm } from "../lookup/lookupApi";
import {
  fetchUnitContent,
  fetchWorks,
  fetchWorkAnchorIndex,
  fetchWorkStructure,
  locateBlockUnit
} from "./readerApi";
import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";
import { ReaderPage } from "./ReaderPage";
import type { BlockDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkStructure = vi.mocked(fetchWorkStructure);
const mockedFetchWorkAnchorIndex = vi.mocked(fetchWorkAnchorIndex);
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

describe("ReaderFigure image lightbox zoom + pan (#381)", () => {
  const captionedFigure = () =>
    figureContent({ alt: "A dot", imageResourceId: "abc123", plaintext: "The caption." });

  async function openViewer(): Promise<{
    dialog: HTMLElement;
    image: HTMLImageElement;
    user: ReturnType<typeof userEvent.setup>;
    viewport: HTMLElement;
  }> {
    const user = userEvent.setup();
    renderReader(captionedFigure());
    await user.click(await screen.findByRole("button", { name: "View larger: A dot" }));
    const dialog = await screen.findByRole("dialog", { name: "A dot" });
    const viewport = dialog.querySelector(".lightbox-viewport") as HTMLElement;
    const image = dialog.querySelector("img.lightbox-image") as HTMLImageElement;
    // jsdom has no layout; give the fit box a size so pan bounds are exercisable.
    Object.defineProperty(viewport, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(viewport, "offsetHeight", { configurable: true, value: 600 });
    return { dialog, image, user, viewport };
  }

  it("opens fit-to-viewport: the image sits in a fit box at scale 1, un-panned", async () => {
    const { image, viewport } = await openViewer();

    // The enlarged image is inside the pannable fit box (the CSS scales it up to fill 96vw x 92vh).
    expect(viewport.contains(image)).toBe(true);
    expect(image.getAttribute("data-zoom")).toBe("1");
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(viewport.getAttribute("data-zoomed")).toBe("false");
  });

  it("disables zoom-out and reset at fit, and enables zoom-in", async () => {
    const { dialog } = await openViewer();

    expect(
      (within(dialog).getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Reset zoom to fit" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("zooms in via the + control and marks the viewport zoomed", async () => {
    const { dialog, image, user, viewport } = await openViewer();

    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));

    expect(image.getAttribute("data-zoom")).toBe("1.6");
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1.6)");
    expect(viewport.getAttribute("data-zoomed")).toBe("true");
    expect(
      (within(dialog).getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("zooms back out a step via the − control", async () => {
    const { dialog, image, user } = await openViewer();

    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    const zoomedIn = Number(image.getAttribute("data-zoom"));

    await user.click(within(dialog).getByRole("button", { name: "Zoom out" }));

    expect(Number(image.getAttribute("data-zoom"))).toBeLessThan(zoomedIn);
    expect(Number(image.getAttribute("data-zoom"))).toBeGreaterThan(1);
  });

  it("bounds zoom-in at the maximum and disables the + control there", async () => {
    const { dialog, image, user } = await openViewer();
    const zoomIn = within(dialog).getByRole("button", { name: "Zoom in" });

    for (let i = 0; i < 6; i += 1) {
      await user.click(zoomIn);
    }

    expect(image.getAttribute("data-zoom")).toBe("5");
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets back to fit (scale 1, no pan) via the reset control", async () => {
    const { dialog, image, user } = await openViewer();

    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    expect(image.getAttribute("data-zoom")).not.toBe("1");

    await user.click(within(dialog).getByRole("button", { name: "Reset zoom to fit" }));

    expect(image.getAttribute("data-zoom")).toBe("1");
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(
      (within(dialog).getByRole("button", { name: "Reset zoom to fit" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("zooms in on a wheel scroll up and back out on a wheel scroll down", async () => {
    const { image, viewport } = await openViewer();

    fireEvent.wheel(viewport, { deltaY: -100 });
    const zoomedIn = Number(image.getAttribute("data-zoom"));
    expect(zoomedIn).toBeGreaterThan(1);

    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(Number(image.getAttribute("data-zoom"))).toBeLessThan(zoomedIn);
  });

  it("pinches to zoom with two pointers", async () => {
    const { image, viewport } = await openViewer();

    firePointer(viewport, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
    firePointer(viewport, "pointerdown", { clientX: 200, clientY: 100, pointerId: 2 });
    firePointer(viewport, "pointermove", { clientX: 300, clientY: 100, pointerId: 2 });

    // Span grew from 100 to 200 -> ratio 2 -> scale 2.
    expect(image.getAttribute("data-zoom")).toBe("2");
  });

  it("keeps scale steady when the two pinch pointers start coincident (zero span)", async () => {
    const { image, viewport } = await openViewer();

    firePointer(viewport, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
    firePointer(viewport, "pointerdown", { clientX: 100, clientY: 100, pointerId: 2 });
    firePointer(viewport, "pointermove", { clientX: 100, clientY: 100, pointerId: 2 });

    expect(image.getAttribute("data-zoom")).toBe("1");
  });

  it("pans by dragging while zoomed, and the drag does not dismiss the viewer", async () => {
    const { dialog, image, user, viewport } = await openViewer();

    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));

    firePointer(viewport, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
    firePointer(viewport, "pointermove", { clientX: 150, clientY: 130, pointerId: 1 });

    // Delta (50, 30) is within the 1.6x pan bounds (extent x=240, y=180).
    expect(image.style.transform).toBe("translate(50px, 30px) scale(1.6)");
    // A pan-drag on the image must not dismiss the dialog.
    expect(screen.queryByRole("dialog")).not.toBeNull();

    // Releasing the last pointer ends the gesture without dismissing.
    firePointer(viewport, "pointerup", { clientX: 150, clientY: 130, pointerId: 1 });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(viewport.getAttribute("data-interacting")).toBe("false");
  });

  it("clamps the pan so the image can't be dragged fully off-screen", async () => {
    const { dialog, image, user, viewport } = await openViewer();

    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));

    firePointer(viewport, "pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
    firePointer(viewport, "pointermove", { clientX: 9999, clientY: 9999, pointerId: 1 });

    // Clamped to the extents at 1.6x: x = 800*0.6/2 = 240, y = 600*0.6/2 = 180 (float-tolerant).
    const [x, y, scale] = image.style.transform.match(/-?\d+(?:\.\d+)?/gu) ?? [];
    expect(Number(x)).toBeCloseTo(240);
    expect(Number(y)).toBeCloseTo(180);
    expect(Number(scale)).toBeCloseTo(1.6);
  });

  it("does not pan for a pointer move that never went through pointer-down", async () => {
    const { image, viewport } = await openViewer();

    firePointer(viewport, "pointermove", { clientX: 200, clientY: 200, pointerId: 42 });

    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("does not resume panning with a leftover finger after one of two lifts", async () => {
    const { image, viewport } = await openViewer();

    firePointer(viewport, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
    firePointer(viewport, "pointerdown", { clientX: 200, clientY: 100, pointerId: 2 });
    // Lift the second finger; the pan start was cleared when the pinch began.
    firePointer(viewport, "pointerup", { clientX: 200, clientY: 100, pointerId: 2 });
    firePointer(viewport, "pointermove", { clientX: 260, clientY: 140, pointerId: 1 });

    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("still dismisses on Escape and the close button after zooming", async () => {
    const { dialog, user } = await openViewer();

    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Re-open and dismiss via the close button.
    await user.click(await screen.findByRole("button", { name: "View larger: A dot" }));
    const reopened = await screen.findByRole("dialog", { name: "A dot" });
    await user.click(within(reopened).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
