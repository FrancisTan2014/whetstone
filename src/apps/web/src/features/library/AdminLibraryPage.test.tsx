// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./libraryApi", () => ({
  createAuthor: vi.fn(),
  createWork: vi.fn(),
  fetchAuthors: vi.fn(),
  fetchWorks: vi.fn(),
  ingestEpub: vi.fn()
}));

import { createAuthor, createWork, fetchAuthors, fetchWorks, ingestEpub } from "./libraryApi";
import { AdminLibraryPage } from "./AdminLibraryPage";
import type { AuthorDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchAuthors = vi.mocked(fetchAuthors);
const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedCreateAuthor = vi.mocked(createAuthor);
const mockedCreateWork = vi.mocked(createWork);
const mockedIngestEpub = vi.mocked(ingestEpub);

const orwell: AuthorDto = { id: toAuthorId("author-1"), name: "George Orwell" };
const dickens: AuthorDto = { id: toAuthorId("author-1"), name: "Charles Dickens" };

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchAuthors.mockResolvedValue({ authors: [] });
  mockedFetchWorks.mockResolvedValue({ works: [] });
});

afterEach(() => {
  cleanup();
});

async function renderReady(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<AdminLibraryPage />);
  await screen.findByRole("heading", { name: "Works" });

  return user;
}

describe("AdminLibraryPage", () => {
  it("shows empty author and work lists once loaded", async () => {
    await renderReady();

    expect(screen.getByText("No authors or sources yet.")).toBeDefined();
    expect(screen.getByText("No works yet.")).toBeDefined();
  });

  it("shows an error state when the initial load fails", async () => {
    mockedFetchAuthors.mockRejectedValue(new Error("network"));

    render(<AdminLibraryPage />);

    expect(await screen.findByText("Could not load the library.")).toBeDefined();
  });

  it("validates that an author name is provided", async () => {
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Add author or source" }));

    expect(screen.getByText("Enter an author or source name.")).toBeDefined();
    expect(mockedCreateAuthor).not.toHaveBeenCalled();
  });

  it("adds an author and shows it in the list", async () => {
    const user = await renderReady();
    mockedCreateAuthor.mockResolvedValue(dickens);
    mockedFetchAuthors.mockResolvedValue({ authors: [dickens] });

    await user.type(screen.getByLabelText("Name"), "Charles Dickens");
    await user.click(screen.getByRole("button", { name: "Add author or source" }));

    const authorsList = await screen.findByRole("list", {
      name: "Existing authors and sources"
    });
    expect(within(authorsList).getByText("Charles Dickens")).toBeDefined();
    expect(mockedCreateAuthor).toHaveBeenCalledWith({ name: "Charles Dickens" });
  });

  it("shows an error when adding an author fails", async () => {
    const user = await renderReady();
    mockedCreateAuthor.mockRejectedValue(new Error("boom"));

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Add author or source" }));

    expect(
      await screen.findByText("Could not save the author or source. Please try again.")
    ).toBeDefined();
  });

  it("validates the work form fields", async () => {
    const user = await renderReady();

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

    expect(mockedCreateWork).toHaveBeenCalledWith({
      author: { mode: "new", name: "吳楚材" },
      language: "zh-TW",
      title: "古文觀止",
      workType: "book"
    });
  });

  it("creates a work with a new inline author", async () => {
    const user = await renderReady();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchAuthors.mockResolvedValue({ authors: [orwell] });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });

    await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
    await user.selectOptions(screen.getByLabelText("Type"), "essay");
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByText("Politics and the English Language — George Orwell (essay, English)")
    ).toBeDefined();
    expect(mockedCreateWork).toHaveBeenCalledWith({
      author: { mode: "new", name: "George Orwell" },
      language: "en",
      title: "Politics and the English Language",
      workType: "essay"
    });
  });

  it("creates a work for an existing author selected from the list", async () => {
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

    await user.selectOptions(screen.getByLabelText("Author or source"), dickens.id);
    await user.type(screen.getByLabelText("Title"), "A Tale of Two Cities");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByText("A Tale of Two Cities — Charles Dickens (book, English)")
    ).toBeDefined();
    const exportLink = screen.getByRole("link", { name: "Export Markdown" });
    expect(exportLink.getAttribute("href")).toBe("/api/works/work-9/content/markdown");
    expect(mockedCreateWork).toHaveBeenCalledWith({
      author: { authorId: dickens.id, mode: "existing" },
      language: "en",
      title: "A Tale of Two Cities",
      workType: "book"
    });
    expect(screen.queryByLabelText("New author or source name")).toBeNull();
  });

  it("shows an error when creating a work fails", async () => {
    const user = await renderReady();
    mockedCreateWork.mockRejectedValue(new Error("boom"));

    await user.type(screen.getByLabelText("Title"), "Doomed");
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not save the work. Please try again.")).toBeDefined();
  });

  it("ingests an EPUB upload and refreshes the work list", async () => {
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
    await user.upload(screen.getByLabelText("Upload an EPUB"), file);

    expect(
      await screen.findByText("史记选读 — 司马迁 (book, 中文（简体） Simplified Chinese)")
    ).toBeDefined();
    expect(mockedIngestEpub).toHaveBeenCalledTimes(1);
  });

  it("shows an error when the EPUB ingestion fails", async () => {
    const user = await renderReady();
    mockedIngestEpub.mockRejectedValue(new Error("boom"));

    const file = new File([new Uint8Array([1])], "bad.epub", { type: "application/epub+zip" });
    await user.upload(screen.getByLabelText("Upload an EPUB"), file);

    expect(await screen.findByText("Could not ingest the EPUB. Please try again.")).toBeDefined();
  });

  it("ignores an upload with no file selected", async () => {
    await renderReady();

    fireEvent.change(screen.getByLabelText("Upload an EPUB"), { target: { files: [] } });

    expect(mockedIngestEpub).not.toHaveBeenCalled();
  });
});
