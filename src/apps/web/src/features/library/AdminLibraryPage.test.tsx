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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./libraryApi", () => ({
  createWork: vi.fn(),
  deleteWork: vi.fn(),
  fetchAuthors: vi.fn(),
  fetchWorks: vi.fn(),
  fetchWorksWithReadingPosition: vi.fn(),
  ingestEpub: vi.fn()
}));

vi.mock("../content/contentApi", () => ({
  ingestMarkdown: vi.fn(),
  ingestPdf: vi.fn()
}));

vi.mock("../authoredWorks/authoredWorkApi", () => ({
  createAuthoredWork: vi.fn(),
  listAuthoredWorks: vi.fn()
}));

vi.mock("../recitation/recitationApi", () => ({
  createRecitationPlan: vi.fn(),
  listRecitationPlans: vi.fn()
}));

import {
  createWork,
  deleteWork,
  fetchAuthors,
  fetchWorks,
  fetchWorksWithReadingPosition,
  ingestEpub
} from "./libraryApi";
import { ingestMarkdown, ingestPdf } from "../content/contentApi";
import { createAuthoredWork, listAuthoredWorks } from "../authoredWorks/authoredWorkApi";
import { createRecitationPlan, listRecitationPlans } from "../recitation/recitationApi";
import { AdminLibraryPage } from "./AdminLibraryPage";
import { ToastProvider } from "../../shared/ui/toast/ToastProvider";
import { ToastViewport } from "../../shared/ui/toast/ToastViewport";
import type {
  AuthorDto,
  AuthoredWorkDto,
  AuthoredWorkSummaryDto,
  RecitationPlanDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toAuthorId, toEntryId } from "@whetstone/domain";

// The library reports action results (work created, EPUB imported, and their failures)
// through the app-wide toast system, so renders run inside a ToastProvider with the live
// region mounted — matching how the shell wires it.
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

const mockedFetchAuthors = vi.mocked(fetchAuthors);
const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorksWithReadingPosition = vi.mocked(fetchWorksWithReadingPosition);
const mockedCreateWork = vi.mocked(createWork);
const mockedDeleteWork = vi.mocked(deleteWork);
const mockedIngestEpub = vi.mocked(ingestEpub);
const mockedIngestMarkdown = vi.mocked(ingestMarkdown);
const mockedIngestPdf = vi.mocked(ingestPdf);
const mockedListAuthoredWorks = vi.mocked(listAuthoredWorks);
const mockedCreateAuthoredWork = vi.mocked(createAuthoredWork);
const mockedListRecitationPlans = vi.mocked(listRecitationPlans);
const mockedCreateRecitationPlan = vi.mocked(createRecitationPlan);

const orwell: AuthorDto = { id: toAuthorId("author-1"), name: "George Orwell" };
const dickens: AuthorDto = { id: toAuthorId("author-2"), name: "Charles Dickens" };

const essayWorkItem: WorkListItemDto = {
  author: orwell,
  work: {
    authorId: orwell.id,
    entryId: toEntryId("work-1"),
    language: "en",
    title: "Politics and the English Language",
    workType: "essay"
  }
};

const animalFarmItem: WorkListItemDto = {
  author: orwell,
  work: {
    authorId: orwell.id,
    entryId: toEntryId("work-2"),
    language: "en",
    title: "Animal Farm",
    workType: "book"
  }
};

function mockMatchMedia(reduce = false): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: query.includes("prefers-reduced-motion") ? reduce : false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  }));
}

beforeAll(() => {
  // jsdom does not implement Blob.text(); the page uses the standard File.text() web API (native in
  // browsers) to read a held Markdown upload, so provide it here via FileReader.
  if (typeof Blob.prototype.text !== "function") {
    Blob.prototype.text = function blobText(this: Blob): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          resolve(String(reader.result));
        });
        reader.addEventListener("error", () => {
          reject(reader.error ?? new Error("Could not read blob."));
        });
        reader.readAsText(this);
      });
    };
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia(false);
  mockedFetchAuthors.mockResolvedValue({ authors: [] });
  mockedFetchWorks.mockResolvedValue({ works: [] });
  mockedFetchWorksWithReadingPosition.mockResolvedValue(new Set());
  mockedListAuthoredWorks.mockResolvedValue({ works: [] });
  mockedListRecitationPlans.mockResolvedValue({ plans: [] });
});

afterEach(() => {
  cleanup();
});

const noop = (): void => {};

async function renderReady(
  onManageContent: (workEntryId: string) => void = noop
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<AdminLibraryPage onManageContent={onManageContent} />);
  await waitFor(() => {
    expect(screen.queryByText("Loading the library…")).toBeNull();
  });

  return user;
}

async function openAddWork(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Add work" }));
  await screen.findByLabelText("Title");
}

describe("AdminLibraryPage", () => {
  it("shows an explicit empty state once loaded with no works", async () => {
    await renderReady();

    expect(
      screen.getByText("No works yet. Add a work or upload a document to start your library.")
    ).toBeDefined();
  });

  it("links to the all-notes review surface from the header (#390)", async () => {
    await renderReady();

    const notesLink = screen.getByRole("link", { name: "Review all notes" });
    expect(notesLink.getAttribute("href")).toBe("#/notes");
  });

  it("shows a loading state before the initial load resolves", async () => {
    render(<AdminLibraryPage onManageContent={noop} />);

    expect(screen.getByText("Loading the library…")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText("Loading the library…")).toBeNull();
    });
  });

  it("shows an error state when the initial load fails", async () => {
    mockedFetchAuthors.mockRejectedValue(new Error("network"));

    render(<AdminLibraryPage onManageContent={noop} />);

    expect(await screen.findByText("Could not load the library.")).toBeDefined();
  });

  it("groups works by author with a per-author count and card affordances", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem, animalFarmItem] });
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    expect(within(group).getByText("2 works")).toBeDefined();
    expect(
      within(group).getByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
    expect(within(group).getByRole("heading", { name: "Animal Farm" })).toBeDefined();
    expect(within(group).getByText("essay · English")).toBeDefined();

    // Default reader label is a truthful "Read" (no saved position seeded above).
    const readLinks = within(group).getAllByRole("link", { name: "Read" });
    expect(readLinks[0]?.getAttribute("href")).toBe("#/reader?work=work-1");

    const notesLinks = within(group).getAllByRole("link", { name: "Notes" });
    expect(notesLinks[0]?.getAttribute("href")).toBe("#/notes?work=work-1");

    const exportLinks = within(group).getAllByRole("link", { name: "Export Markdown" });
    expect(exportLinks[0]?.getAttribute("href")).toBe("/api/works/work-1/content/markdown");

    expect(within(group).getAllByRole("button", { name: "Manage content" })).toHaveLength(2);
  });

  it("gives every per-work card action a >=44px hit target (#463)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    const actions = [
      within(group).getByRole("link", { name: "Read" }),
      within(group).getByRole("button", { name: "Manage content" }),
      within(group).getByRole("link", { name: "Notes" }),
      within(group).getByRole("link", { name: "Export Markdown" })
    ];

    // jsdom has no layout, so assert the sizing utilities that drive the >=44px target in both
    // dimensions (min-h-11 = min-w-11 = 44px), like Button's target-size test. Dropping either fails.
    for (const action of actions) {
      expect(action.className).toContain("min-h-11");
      expect(action.className).toContain("min-w-11");
    }
  });

  it("labels the reader link 'Continue' only for works with a saved reading position", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem, animalFarmItem] });
    mockedFetchWorksWithReadingPosition.mockResolvedValue(new Set(["work-2"]));
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    const continueLink = within(group).getByRole("link", { name: "Continue" });
    expect(continueLink.getAttribute("href")).toBe("#/reader?work=work-2");
    const readLink = within(group).getByRole("link", { name: "Read" });
    expect(readLink.getAttribute("href")).toBe("#/reader?work=work-1");
  });

  it("asks the parent to open the manage-content surface for a work", async () => {
    const onManageContent = vi.fn();
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const group = await screen.findByRole("region", { name: "George Orwell" });
    await user.click(within(group).getByRole("button", { name: "Manage content" }));

    expect(onManageContent).toHaveBeenCalledWith("work-1");
  });

  it("renders a singular work count for an author with one work", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    expect(within(group).getByText("1 work")).toBeDefined();
  });

  it("validates the work form fields in the add-work dialog", async () => {
    const user = await renderReady();
    await openAddWork(user);

    await user.click(screen.getByRole("button", { name: "Create work" }));
    expect(screen.getByText("Enter a work title.")).toBeDefined();

    await user.type(screen.getByLabelText("Title"), "Some Work");
    await user.click(screen.getByRole("button", { name: "Create work" }));
    expect(
      screen.getByText("Select an existing author or source, or name a new one.")
    ).toBeDefined();

    expect(mockedCreateWork).not.toHaveBeenCalled();
  });

  it("offers exactly the three supported languages and submits the chosen code", async () => {
    const user = await renderReady();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await openAddWork(user);

    const languageSelect = screen.getByLabelText("Language") as HTMLSelectElement;
    expect([...languageSelect.options].map((option) => option.value)).toEqual([
      "zh-CN",
      "zh-TW",
      "en"
    ]);

    await user.type(screen.getByLabelText("Title"), "古文觀止");
    await user.selectOptions(languageSelect, "zh-TW");
    await user.type(screen.getByLabelText("New author or source name"), "吳楚材");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedCreateWork).toHaveBeenCalledWith({
        author: { mode: "new", name: "吳楚材" },
        language: "zh-TW",
        title: "古文觀止",
        workType: "book"
      });
    });
  });

  it("creates a work with a new inline author and shows it grouped", async () => {
    const user = await renderReady();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
    await user.selectOptions(screen.getByLabelText("Type"), "essay");
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
    expect(await screen.findByText("Added “Politics and the English Language”.")).toBeDefined();
    expect(mockedCreateWork).toHaveBeenCalledWith({
      author: { mode: "new", name: "George Orwell" },
      language: "en",
      title: "Politics and the English Language",
      workType: "essay"
    });
  });

  it("creates a work for an existing author selected from the dropdown", async () => {
    mockedFetchAuthors.mockResolvedValue({ authors: [dickens] });
    const user = await renderReady();
    const bookItem: WorkListItemDto = {
      author: dickens,
      work: {
        authorId: dickens.id,
        entryId: toEntryId("work-9"),
        language: "en",
        title: "A Tale of Two Cities",
        workType: "book"
      }
    };
    mockedCreateWork.mockResolvedValue(bookItem);
    mockedFetchWorks.mockResolvedValue({ works: [bookItem] });
    await openAddWork(user);

    await user.selectOptions(screen.getByLabelText("Author or source"), dickens.id);
    expect(screen.queryByLabelText("New author or source name")).toBeNull();
    await user.type(screen.getByLabelText("Title"), "A Tale of Two Cities");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByRole("heading", { name: "A Tale of Two Cities" })).toBeDefined();
    expect(mockedCreateWork).toHaveBeenCalledWith({
      author: { authorId: dickens.id, mode: "existing" },
      language: "en",
      title: "A Tale of Two Cities",
      workType: "book"
    });
  });

  it("opens the manage-content surface for a freshly created work", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
  });

  it("shows an error when creating a work fails", async () => {
    const user = await renderReady();
    mockedCreateWork.mockRejectedValue(new Error("boom"));
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Doomed");
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not save the work. Please try again.")).toBeDefined();
  });

  it("gives every Add work sheet control a >=44px hit target (#479)", async () => {
    const user = await renderReady();
    await openAddWork(user);

    // jsdom has no layout, so assert the sizing utilities (min-h-11 = 44px) on each control. The
    // fields were ~41-42px tall and the close control ~29x32 before this fix.
    const fields = [
      screen.getByLabelText("Title"),
      screen.getByLabelText("Type"),
      screen.getByLabelText("Language"),
      screen.getByLabelText("Author or source"),
      screen.getByLabelText("New author or source name")
    ];
    for (const field of fields) {
      expect(field.className).toContain("min-h-11");
    }
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("min-h-11");
    expect(close.className).toContain("min-w-11");
  });

  it("disables the create button while the work is saving so it cannot double-submit", async () => {
    let resolveCreate: (value: WorkListItemDto) => void = () => {};
    mockedCreateWork.mockImplementation(
      () =>
        new Promise<WorkListItemDto>((resolve) => {
          resolveCreate = resolve;
        })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Pending Work");
    await user.type(screen.getByLabelText("New author or source name"), "Someone");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    const createButton = screen.getByRole("button", { name: "Create work" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(createButton.getAttribute("aria-busy")).toBe("true");
    });
    expect(createButton.disabled).toBe(true);
    expect(mockedCreateWork).toHaveBeenCalledTimes(1);

    resolveCreate(essayWorkItem);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Create work" })).toBeNull();
    });
  });

  it("ingests an EPUB upload and refreshes the grouped works", async () => {
    const user = await renderReady();
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      author: epubAuthor,
      work: {
        authorId: epubAuthor.id,
        entryId: toEntryId("work-epub"),
        language: "zh-CN",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      content: { readingUnits: [], workEntryId: epubWork.work.entryId },
      work: epubWork.work
    });
    mockedFetchWorks.mockResolvedValue({ works: [epubWork] });

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(await screen.findByRole("heading", { name: "史记选读" })).toBeDefined();
    expect(await screen.findByText("Imported “史记选读”.")).toBeDefined();
    expect(mockedIngestEpub).toHaveBeenCalledTimes(1);
  });

  it("does not open the manage-content surface after an EPUB import", async () => {
    const onManageContent = vi.fn();
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      author: epubAuthor,
      work: {
        authorId: epubAuthor.id,
        entryId: toEntryId("work-epub"),
        language: "zh-CN",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      content: { readingUnits: [], workEntryId: epubWork.work.entryId },
      work: epubWork.work
    });
    mockedFetchWorks.mockResolvedValue({ works: [epubWork] });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(await screen.findByText("Imported “史记选读”.")).toBeDefined();
    expect(onManageContent).not.toHaveBeenCalled();
  });

  it("shows an error when the EPUB ingestion fails", async () => {
    const user = await renderReady();
    mockedIngestEpub.mockRejectedValue(new Error("boom"));

    const file = new File([new Uint8Array([1])], "bad.epub", { type: "application/epub+zip" });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(await screen.findByText("Could not ingest the EPUB. Please try again.")).toBeDefined();
  });

  it("ignores an upload with no file selected", async () => {
    await renderReady();

    fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [] } });

    expect(mockedIngestEpub).not.toHaveBeenCalled();
  });

  it("labels the shelf control 'Upload' and accepts epub, pdf, and md", async () => {
    await renderReady();

    const input = screen.getByLabelText("Upload") as HTMLInputElement;
    expect(input.accept).toBe(".epub,application/epub+zip,.pdf,application/pdf,.md,text/markdown");
  });

  it("ingests a selected EPUB directly without showing the Add-work form", async () => {
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      author: epubAuthor,
      work: {
        authorId: epubAuthor.id,
        entryId: toEntryId("work-epub"),
        language: "zh-CN",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      content: { readingUnits: [], workEntryId: epubWork.work.entryId },
      work: epubWork.work
    });
    mockedFetchWorks.mockResolvedValue({ works: [epubWork] });
    const user = await renderReady();

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(await screen.findByText("Imported “史记选读”.")).toBeDefined();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(mockedCreateWork).not.toHaveBeenCalled();
  });

  it("routes by MIME type first: a PDF mislabelled .epub takes the PDF confirm path", async () => {
    const user = await renderReady();

    // Real content type is PDF even though the filename ends in .epub — MIME must win, so this opens
    // the PDF/Markdown confirm sheet rather than ingesting directly as an EPUB.
    const file = new File([new Uint8Array([1])], "mislabelled.epub", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("mislabelled");
    expect(mockedIngestEpub).not.toHaveBeenCalled();
  });

  it("prefills the Add-work sheet from a Markdown filename, then creates and ingests it", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestMarkdown.mockResolvedValue({
      content: { readingUnits: [], workEntryId: essayWorkItem.work.entryId },
      status: "ingested"
    });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const file = new File(["# Politics"], "Politics and the English Language.md", {
      type: "text/markdown"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Politics and the English Language");
    expect(mockedCreateWork).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedCreateWork).toHaveBeenCalledWith({
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        title: "Politics and the English Language",
        workType: "book"
      });
    });
    await waitFor(() => {
      expect(mockedIngestMarkdown).toHaveBeenCalledWith("work-1", {
        fileName: "Politics and the English Language.md",
        kind: "upload",
        markdown: "# Politics"
      });
    });
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
    expect(await screen.findByText("Imported “Politics and the English Language”.")).toBeDefined();
  });

  it("prefills from a PDF filename, then creates, ingests, and opens Manage content", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestPdf.mockResolvedValue({
      content: { readingUnits: [], workEntryId: essayWorkItem.work.entryId },
      status: "ingested"
    });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1, 2, 3])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Report");

    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedCreateWork).toHaveBeenCalledWith({
        author: { mode: "new", name: "Nobody" },
        language: "en",
        title: "Report",
        workType: "book"
      });
    });
    await waitFor(() => {
      expect(mockedIngestPdf).toHaveBeenCalledWith("work-1", file);
    });
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
    expect(await screen.findByText("Imported “Report”.")).toBeDefined();
  });

  it("surfaces the invalid-PDF message but still opens the new Work for retry", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestPdf.mockResolvedValue({ status: "invalid_pdf" });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1])], "scan.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByText("We couldn’t read this PDF. Please try a different file.")
    ).toBeDefined();
    // The Work was created, so it must remain visible and retryable from Manage content.
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
  });

  it("surfaces a distinct setup message when the PDF toolchain is missing (not a bad file) (#510)", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestPdf.mockResolvedValue({ status: "pdf_toolchain_missing" });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1])], "valid.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    const message = await screen.findByText(/PDF ingestion isn’t set up on the server yet/);
    expect(message.textContent).toContain("pnpm setup:pdf");
    // It must NOT read as an unreadable/corrupt file.
    expect(
      screen.queryByText("We couldn’t read this PDF. Please try a different file.")
    ).toBeNull();
    // The Work was created, so it stays retryable once the lane is provisioned.
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
  });

  it("surfaces the empty-content message when a PDF has no readable text", async () => {
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestPdf.mockResolvedValue({ status: "empty_content" });
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "blank.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByText(
        "This document has no readable text to add. Images on their own aren’t supported yet."
      )
    ).toBeDefined();
  });

  it("surfaces the empty-content message when a Markdown upload has no readable text", async () => {
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestMarkdown.mockResolvedValue({ status: "empty_content" });
    const user = await renderReady();

    const file = new File(["![only image](x.png)"], "images.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByText(
        "This document has no readable text to add. Images on their own aren’t supported yet."
      )
    ).toBeDefined();
  });

  it("shows a generic error toast but still opens the new Work when the ingest throws", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestPdf.mockRejectedValue(new Error("boom"));
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1])], "doc.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not ingest the file. Please try again.")).toBeDefined();
    // Even on an unexpected failure the created Work is surfaced for retry.
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
  });

  it("rejects an unsupported file type with an error and ingests nothing", async () => {
    await renderReady();

    const file = new File(["plain"], "notes.txt", { type: "text/plain" });
    // Bypass the input's accept filter to exercise the client-side type guard.
    fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [file] } });

    expect(await screen.findByText("Choose an .epub, .pdf, or .md file.")).toBeDefined();
    expect(mockedCreateWork).not.toHaveBeenCalled();
    expect(mockedIngestEpub).not.toHaveBeenCalled();
  });

  it("drops a held upload when the Add-work sheet is dismissed", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const held = new File(["# X"], "held.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Upload"), held);
    await screen.findByLabelText("Title");

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Title")).toBeNull();
    });

    // A fresh, purely-manual Add work must not ingest the previously held file.
    await user.click(screen.getByRole("button", { name: "Add work" }));
    await screen.findByLabelText("Title");
    await user.type(screen.getByLabelText("Title"), "Manual Work");
    await user.type(screen.getByLabelText("New author or source name"), "Someone");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
    expect(mockedIngestMarkdown).not.toHaveBeenCalled();
  });

  it("shows the EPUB progress indicator while an EPUB ingests", async () => {
    let resolveIngest: (value: Awaited<ReturnType<typeof ingestEpub>>) => void = () => {};
    mockedIngestEpub.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIngest = resolve;
        })
    );
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "book.epub", { type: "application/epub+zip" });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(await screen.findByText("Ingesting the EPUB…")).toBeDefined();

    resolveIngest({
      content: { readingUnits: [], workEntryId: toEntryId("work-epub") },
      work: {
        authorId: toAuthorId("author-9"),
        entryId: toEntryId("work-epub"),
        language: "en",
        title: "Book",
        workType: "book"
      }
    });
    await waitFor(() => {
      expect(screen.queryByText("Ingesting the EPUB…")).toBeNull();
    });
  });

  it("shows the PDF progress indicator while a held PDF ingests", async () => {
    let resolveIngest: (value: Awaited<ReturnType<typeof ingestPdf>>) => void = () => {};
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedIngestPdf.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIngest = resolve;
        })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Converting the PDF…")).toBeDefined();

    resolveIngest({
      content: { readingUnits: [], workEntryId: essayWorkItem.work.entryId },
      status: "ingested"
    });
    await waitFor(() => {
      expect(screen.queryByText("Converting the PDF…")).toBeNull();
    });
  });

  it("renders cards without entrance offset when reduced motion is preferred", async () => {
    mockMatchMedia(true);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    expect(
      await screen.findByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
  });

  it("deletes a work after an explicit confirmation naming it (#541)", async () => {
    mockedFetchWorks
      .mockResolvedValueOnce({ works: [essayWorkItem] })
      .mockResolvedValue({ works: [] });
    mockedDeleteWork.mockResolvedValue(undefined);
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    // The confirm dialog names the work and the destructive act.
    const dialog = await screen.findByRole("dialog", { name: "Delete work" });
    expect(within(dialog).getByText(/Politics and the English Language/)).toBeDefined();

    await user.click(within(dialog).getByRole("button", { name: "Delete work" }));

    await waitFor(() => {
      expect(mockedDeleteWork).toHaveBeenCalledWith(essayWorkItem.work.entryId);
    });
    // The shelf refreshed and the work is gone.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Politics and the English Language" })
      ).toBeNull();
    });
    expect(await screen.findByText("Deleted “Politics and the English Language”.")).toBeDefined();
  });

  it("keeps the work when the delete confirmation is cancelled", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete work" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete work" })).toBeNull();
    });
    expect(mockedDeleteWork).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
  });

  it("dismisses the delete confirmation on Escape without deleting", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete work" });
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete work" })).toBeNull();
    });
    expect(mockedDeleteWork).not.toHaveBeenCalled();
  });

  it("surfaces an error and keeps the work when the delete fails", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedDeleteWork.mockRejectedValue(new Error("boom"));
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete work" });
    await user.click(within(dialog).getByRole("button", { name: "Delete work" }));

    expect(await screen.findByText("Could not delete the work. Please try again.")).toBeDefined();
    // The confirm dialog stays open (the work was not removed).
    expect(screen.getByRole("dialog", { name: "Delete work" })).toBeDefined();
  });

  it("marks a Work authored with a badge, opens it in the reader and editor, and hides Manage content + Markdown export (#576)", async () => {
    const authoredSummary: AuthoredWorkSummaryDto = {
      createdAt: "2026-07-01T00:00:00.000Z",
      entryId: "work-1",
      language: "en",
      title: "Politics and the English Language",
      updatedAt: "2026-07-02T00:00:00.000Z",
      workType: "essay"
    };
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem, animalFarmItem] });
    mockedListAuthoredWorks.mockResolvedValue({ works: [authoredSummary] });
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    const authoredCard = within(group)
      .getByRole("heading", { name: "Politics and the English Language" })
      .closest("li");
    expect(authoredCard).not.toBeNull();
    const authored = within(authoredCard as HTMLElement);
    // The authored badge plus a shared-reader Read link (where selection → notes and search deep-links
    // work) and an editor Edit link — but no Manage-content and no broken Markdown export (#576).
    expect(authored.getByText("Authored")).toBeDefined();
    expect(authored.getByRole("link", { name: "Read" }).getAttribute("href")).toBe(
      "#/reader?work=work-1"
    );
    expect(authored.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe(
      "#/write?work=work-1"
    );
    expect(authored.queryByRole("button", { name: "Manage content" })).toBeNull();
    expect(authored.queryByRole("link", { name: "Export Markdown" })).toBeNull();
    // Notes stays available across both authored and imported works.
    expect(authored.getByRole("link", { name: "Notes" }).getAttribute("href")).toBe(
      "#/notes?work=work-1"
    );

    // A non-authored Work keeps the reader flow, Manage content, and Markdown export.
    const importedCard = within(group).getByRole("heading", { name: "Animal Farm" }).closest("li");
    const imported = within(importedCard as HTMLElement);
    expect(imported.queryByText("Authored")).toBeNull();
    expect(imported.getByRole("link", { name: "Read" }).getAttribute("href")).toBe(
      "#/reader?work=work-2"
    );
    expect(imported.getByRole("button", { name: "Manage content" })).toBeDefined();
    expect(imported.getByRole("link", { name: "Export Markdown" })).toBeDefined();
  });

  it("creates a new authored document and jumps into the editor (#576)", async () => {
    window.location.hash = "";
    const created: AuthoredWorkDto = {
      createdAt: "2026-07-01T00:00:00.000Z",
      document: createTextDocument(""),
      entryId: "doc 42",
      language: "zh-CN",
      title: "My new essay",
      unitEntryId: "unit-1",
      updatedAt: "2026-07-01T00:00:00.000Z",
      workType: "essay"
    };
    mockedCreateAuthoredWork.mockResolvedValue(created);
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("heading", { name: "New document" });
    await user.type(screen.getByLabelText("Title"), "My new essay");
    await user.selectOptions(screen.getByLabelText("Type"), "essay");
    await user.selectOptions(screen.getByLabelText("Language"), "zh-CN");
    await user.click(screen.getByRole("button", { name: "Create and write" }));

    await waitFor(() => {
      expect(mockedCreateAuthoredWork).toHaveBeenCalledWith({
        language: "zh-CN",
        title: "My new essay",
        workType: "essay"
      });
    });
    expect(window.location.hash).toBe("#/write?work=doc%2042");
  });

  it("validates that a new document needs a title before creating (#576)", async () => {
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("heading", { name: "New document" });
    await user.click(screen.getByRole("button", { name: "Create and write" }));

    expect(await screen.findByText("Enter a document title.")).toBeDefined();
    expect(mockedCreateAuthoredWork).not.toHaveBeenCalled();
  });

  it("shows an error toast when creating a new document fails (#576)", async () => {
    mockedCreateAuthoredWork.mockRejectedValue(new Error("boom"));
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("heading", { name: "New document" });
    await user.type(screen.getByLabelText("Title"), "Doomed doc");
    await user.click(screen.getByRole("button", { name: "Create and write" }));

    expect(
      await screen.findByText("Could not create the document. Please try again.")
    ).toBeDefined();
  });

  it("dismisses the New document sheet without creating anything (#576)", async () => {
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "New document" }));
    await screen.findByRole("heading", { name: "New document" });
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "New document" })).toBeNull();
    });
    expect(mockedCreateAuthoredWork).not.toHaveBeenCalled();
  });

  const recitationPlanFor = (workEntryId: string, title: string): RecitationPlanDto => ({
    createdAt: "2026-07-01T09:00:00.000Z",
    entryId: `plan-${workEntryId}`,
    lastSessionAt: null,
    phase: "familiarizing",
    sessionCount: 0,
    updatedAt: "2026-07-01T09:00:00.000Z",
    workEntryId,
    workTitle: title
  });

  it("adopts a Work for recitation in the chosen phase, then marks it on the card (#577)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedCreateRecitationPlan.mockResolvedValue(
      recitationPlanFor("work-1", "Politics and the English Language")
    );
    // The reload after adopting reports the new plan so the card flips to the reciting status.
    mockedListRecitationPlans.mockResolvedValueOnce({ plans: [] }).mockResolvedValue({
      plans: [recitationPlanFor("work-1", "Politics and the English Language")]
    });
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Practise recitation" }));
    await screen.findByRole("heading", { name: "Practise recitation" });
    await user.selectOptions(screen.getByLabelText("Starting phase"), "maintenance");
    await user.click(screen.getByRole("button", { name: "Add to routines" }));

    await waitFor(() => {
      expect(mockedCreateRecitationPlan).toHaveBeenCalledWith({
        phase: "maintenance",
        workEntryId: "work-1"
      });
    });
    expect(
      await screen.findByText(
        "Added “Politics and the English Language” to your recitation routines."
      )
    ).toBeDefined();
    // The card now shows the quiet reciting status instead of the adopt action.
    expect(await screen.findByText("Reciting · Familiarizing")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Practise recitation" })).toBeNull();
    // A familiarizing plan does NOT expose passage practice — that is the opt-in Learning-phase engine,
    // reached first via Today's "Start reciting" (#578).
    expect(screen.queryByRole("link", { name: "Divide into passages" })).toBeNull();
  });

  it("shows the reciting status (not an adopt button) for an already-adopted Work (#577)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedListRecitationPlans.mockResolvedValue({
      plans: [
        { ...recitationPlanFor("work-1", "Politics and the English Language"), phase: "learning" }
      ]
    });
    await renderReady();

    expect(await screen.findByText("Reciting · Learning")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Practise recitation" })).toBeNull();
    expect(screen.getByRole("link", { name: "Divide into passages" }).getAttribute("href")).toBe(
      "#/recite?plan=plan-work-1"
    );
  });

  it("surfaces an error when adopting a recitation routine fails, keeping the sheet open (#577)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedCreateRecitationPlan.mockRejectedValue(new Error("boom"));
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Practise recitation" }));
    await screen.findByRole("heading", { name: "Practise recitation" });
    await user.click(screen.getByRole("button", { name: "Add to routines" }));

    expect(
      await screen.findByText("Could not start this recitation routine. Please try again.")
    ).toBeDefined();
  });

  it("dismisses the Practise recitation sheet without adopting anything (#577)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Practise recitation" }));
    await screen.findByRole("heading", { name: "Practise recitation" });
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Practise recitation" })).toBeNull();
    });
    expect(mockedCreateRecitationPlan).not.toHaveBeenCalled();
  });
});
