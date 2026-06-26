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

vi.mock("./libraryApi", () => ({
  createWork: vi.fn(),
  fetchAuthors: vi.fn(),
  fetchWorks: vi.fn(),
  ingestEpub: vi.fn()
}));

import { createWork, fetchAuthors, fetchWorks, ingestEpub } from "./libraryApi";
import { AdminLibraryPage } from "./AdminLibraryPage";
import { ToastProvider } from "../../shared/ui/toast/ToastProvider";
import { ToastViewport } from "../../shared/ui/toast/ToastViewport";
import type { AuthorDto, WorkListItemDto } from "@whetstone/contracts";
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
const mockedCreateWork = vi.mocked(createWork);
const mockedIngestEpub = vi.mocked(ingestEpub);

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

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia(false);
  mockedFetchAuthors.mockResolvedValue({ authors: [] });
  mockedFetchWorks.mockResolvedValue({ works: [] });
});

afterEach(() => {
  cleanup();
});

async function renderReady(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<AdminLibraryPage />);
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
      screen.getByText("No works yet. Add a work or upload an EPUB to start your library.")
    ).toBeDefined();
  });

  it("shows a loading state before the initial load resolves", async () => {
    render(<AdminLibraryPage />);

    expect(screen.getByText("Loading the library…")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText("Loading the library…")).toBeNull();
    });
  });

  it("shows an error state when the initial load fails", async () => {
    mockedFetchAuthors.mockRejectedValue(new Error("network"));

    render(<AdminLibraryPage />);

    expect(await screen.findByText("Could not load the library.")).toBeDefined();
  });

  it("groups works by author with a per-author count and reader/export affordances", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem, animalFarmItem] });
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    expect(within(group).getByText("2 works")).toBeDefined();
    expect(
      within(group).getByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
    expect(within(group).getByRole("heading", { name: "Animal Farm" })).toBeDefined();
    expect(within(group).getByText("essay · English")).toBeDefined();

    const continueLinks = within(group).getAllByRole("link", { name: "Continue reading" });
    expect(continueLinks[0]?.getAttribute("href")).toBe("#/reader?work=work-1");

    const exportLinks = within(group).getAllByRole("link", { name: "Export Markdown" });
    expect(exportLinks[0]?.getAttribute("href")).toBe("/api/works/work-1/content/markdown");
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

  it("notifies the parent of the created work so a sibling panel can refresh and select it", async () => {
    const onWorkCreated = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = userEvent.setup();
    render(<AdminLibraryPage onWorkCreated={onWorkCreated} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading the library…")).toBeNull();
    });
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(onWorkCreated).toHaveBeenCalledWith("work-1");
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
    await user.upload(screen.getByLabelText("Upload EPUB"), file);

    expect(await screen.findByRole("heading", { name: "史记选读" })).toBeDefined();
    expect(await screen.findByText("Imported “史记选读”.")).toBeDefined();
    expect(mockedIngestEpub).toHaveBeenCalledTimes(1);
  });

  it("notifies the parent of an EPUB-imported work so a sibling panel can refresh and select it", async () => {
    const onWorkCreated = vi.fn();
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
    const user = userEvent.setup();
    render(<AdminLibraryPage onWorkCreated={onWorkCreated} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading the library…")).toBeNull();
    });

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload EPUB"), file);

    await waitFor(() => {
      expect(onWorkCreated).toHaveBeenCalledWith("work-epub");
    });
  });

  it("shows an error when the EPUB ingestion fails", async () => {
    const user = await renderReady();
    mockedIngestEpub.mockRejectedValue(new Error("boom"));

    const file = new File([new Uint8Array([1])], "bad.epub", { type: "application/epub+zip" });
    await user.upload(screen.getByLabelText("Upload EPUB"), file);

    expect(await screen.findByText("Could not ingest the EPUB. Please try again.")).toBeDefined();
  });

  it("ignores an upload with no file selected", async () => {
    await renderReady();

    fireEvent.change(screen.getByLabelText("Upload EPUB"), { target: { files: [] } });

    expect(mockedIngestEpub).not.toHaveBeenCalled();
  });

  it("renders cards without entrance offset when reduced motion is preferred", async () => {
    mockMatchMedia(true);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    expect(
      await screen.findByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
  });
});
