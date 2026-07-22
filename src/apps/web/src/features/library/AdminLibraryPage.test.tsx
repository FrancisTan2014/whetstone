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
import type * as ReactRouterDom from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./libraryApi", () => ({
  createWork: vi.fn(),
  deleteWork: vi.fn(),
  fetchWorks: vi.fn(),
  fetchWorksWithReadingPosition: vi.fn(),
  importMarkdownWork: vi.fn(),
  ingestEpub: vi.fn(),
  searchAuthors: vi.fn()
}));

// The real create-or-select combobox is exercised in AuthorSelectField.test.tsx; here we stub it to a
// minimal control that drives `onSelectionChange` directly, so page-level tests assert the form's own
// behavior (validation, submit payload, reset, sheet lifecycle) without the debounced search/listbox.
vi.mock("./AuthorSelectField", () => ({
  AuthorSelectField: ({
    onSelectionChange
  }: {
    onSelectionChange: (selection: WorkAuthorSelection | undefined) => void;
  }) => (
    <label>
      New author or source name
      <input
        aria-label="New author or source name"
        onChange={(event) => {
          const value = (event.target as HTMLInputElement).value;
          onSelectionChange(value === "" ? undefined : { mode: "new", name: value });
        }}
      />
      <button
        onClick={() =>
          onSelectionChange({ authorId: "author-2", mode: "existing" } as WorkAuthorSelection)
        }
        type="button"
      >
        Use existing author
      </button>
    </label>
  )
}));

vi.mock("../content/contentApi", () => ({
  ingestPdf: vi.fn()
}));

vi.mock("../recitation/recitationApi", () => ({
  enrollRecitation: vi.fn(),
  listRecitationPlans: vi.fn()
}));

const navigateSpy = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouterDom>()),
  useNavigate: () => navigateSpy
}));

import {
  createWork,
  deleteWork,
  fetchWorks,
  fetchWorksWithReadingPosition,
  importMarkdownWork,
  ingestEpub,
  searchAuthors
} from "./libraryApi";
import { ingestPdf } from "../content/contentApi";
import { enrollRecitation, listRecitationPlans } from "../recitation/recitationApi";
import { AdminLibraryPage } from "./AdminLibraryPage";
import { ToastProvider } from "../../shared/ui/toast/ToastProvider";
import { ToastViewport } from "../../shared/ui/toast/ToastViewport";
import { MemoryRouter } from "react-router-dom";
import type {
  AuthorDto,
  RecitationPlanDto,
  WorkAuthorSelection,
  WorkListItemDto
} from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

// The library reports action results (work created, EPUB imported, and their failures)
// through the app-wide toast system, so renders run inside a ToastProvider with the live
// region mounted — matching how the shell wires it.
function ToastHost({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <MemoryRouter>
      <ToastProvider>
        {children}
        <ToastViewport />
      </ToastProvider>
    </MemoryRouter>
  );
}

function render(ui: React.ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { wrapper: ToastHost });
}

const mockedSearchAuthors = vi.mocked(searchAuthors);
const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorksWithReadingPosition = vi.mocked(fetchWorksWithReadingPosition);
const mockedCreateWork = vi.mocked(createWork);
const mockedDeleteWork = vi.mocked(deleteWork);
const mockedIngestEpub = vi.mocked(ingestEpub);
const mockedImportMarkdownWork = vi.mocked(importMarkdownWork);
const mockedIngestPdf = vi.mocked(ingestPdf);
const mockedListRecitationPlans = vi.mocked(listRecitationPlans);
const mockedEnrollRecitation = vi.mocked(enrollRecitation);

const orwell: AuthorDto = { id: toAuthorId("author-1"), name: "George Orwell" };
const dickens: AuthorDto = { id: toAuthorId("author-2"), name: "Charles Dickens" };

const essayWorkItem: WorkListItemDto = {
  author: orwell,
  work: {
    authorId: orwell.id,
    entryId: toEntryId("work-1"),
    language: "en",
    origin: "imported",
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
    origin: "imported",
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
  // Radix DropdownMenu reads pointer-capture and layout APIs jsdom lacks; stub them so opening the
  // header Add menu and the per-Work overflow menu does not throw during interaction tests.
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {}
  });

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
  mockedSearchAuthors.mockResolvedValue({ authors: [], cleanedQuery: "", exactMatchId: null });
  mockedFetchWorks.mockResolvedValue({ works: [] });
  mockedFetchWorksWithReadingPosition.mockResolvedValue(new Set());
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

async function openAddMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Add" }));
  // Radix labels the menu by its trigger (aria-labelledby), so the menu's accessible name is "Add".
  return screen.findByRole("menu", { name: "Add" });
}

async function openAddWork(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const menu = await openAddMenu(user);
  await user.click(within(menu).getByRole("menuitem", { name: "Add work manually" }));
  await screen.findByLabelText("Title");
}

// Open a Work card's overflow menu by the card title and return the menu node for scoped queries.
async function openWorkOverflow(
  user: ReturnType<typeof userEvent.setup>,
  title: string
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: `More actions for ${title}` }));
  // Radix labels the menu by its trigger, so its accessible name matches the trigger's.
  return screen.findByRole("menu", { name: `More actions for ${title}` });
}

describe("AdminLibraryPage", () => {
  it("shows an explicit empty state once loaded with no works", async () => {
    await renderReady();

    expect(
      screen.getByText("No works yet. Use Add above to upload a file or create your first work.")
    ).toBeDefined();
  });

  it("shows a loading state before the initial load resolves", async () => {
    render(<AdminLibraryPage onManageContent={noop} />);

    expect(screen.getByText("Loading the library…")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText("Loading the library…")).toBeNull();
    });
  });

  it("shows an error state when the initial load fails", async () => {
    mockedFetchWorks.mockRejectedValue(new Error("network"));

    render(<AdminLibraryPage onManageContent={noop} />);

    expect(await screen.findByText("Could not load the library.")).toBeDefined();
  });

  it("groups works by author with a per-author count and one primary read action", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem, animalFarmItem] });
    const user = await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    expect(within(group).getByText("2 works")).toBeDefined();
    expect(
      within(group).getByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
    expect(within(group).getByRole("heading", { name: "Animal Farm" })).toBeDefined();
    expect(within(group).getByText("essay · English")).toBeDefined();

    // Default reader label is a truthful "Read" (no saved position seeded above); it is the single
    // persistent action on the card face, alongside the overflow trigger.
    const readLinks = within(group).getAllByRole("link", { name: "Read" });
    expect(readLinks[0]?.getAttribute("href")).toBe("#/reader?work=work-1");

    // Secondary management is behind the overflow menu; nothing but Read + the overflow trigger shows
    // on the card face — no Notes, Manage content, or Markdown export links compete on the surface.
    expect(within(group).queryByRole("menuitem", { name: "View notes" })).toBeNull();
    expect(within(group).queryByRole("button", { name: "Manage content" })).toBeNull();
    expect(within(group).queryByRole("link", { name: "Export Markdown" })).toBeNull();

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    expect(
      within(overflow).getByRole("menuitem", { name: "View notes" }).getAttribute("href")
    ).toBe("#/notes?work=work-1");
    expect(within(overflow).getByRole("menuitem", { name: "Manage content" })).toBeDefined();
    expect(within(overflow).queryByRole("menuitem", { name: "Export Markdown" })).toBeNull();
  });

  it("gives the persistent card controls a >=44px hit target (#463)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    const actions = [
      within(group).getByRole("link", { name: "Read" }),
      within(group).getByRole("button", {
        name: "More actions for Politics and the English Language"
      })
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

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    await user.click(within(overflow).getByRole("menuitem", { name: "Manage content" }));

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
        origin: "manual",
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
      origin: "manual",
      title: "Politics and the English Language",
      workType: "essay"
    });
  });

  it("creates a work for an existing author chosen from the author field", async () => {
    const user = await renderReady();
    const bookItem: WorkListItemDto = {
      author: dickens,
      work: {
        authorId: dickens.id,
        entryId: toEntryId("work-9"),
        language: "en",
        origin: "manual",
        title: "A Tale of Two Cities",
        workType: "book"
      }
    };
    mockedCreateWork.mockResolvedValue(bookItem);
    mockedFetchWorks.mockResolvedValue({ works: [bookItem] });
    await openAddWork(user);

    await user.click(screen.getByRole("button", { name: "Use existing author" }));
    await user.type(screen.getByLabelText("Title"), "A Tale of Two Cities");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByRole("heading", { name: "A Tale of Two Cities" })).toBeDefined();
    expect(mockedCreateWork).toHaveBeenCalledWith({
      author: { authorId: dickens.id, mode: "existing" },
      language: "en",
      origin: "manual",
      title: "A Tale of Two Cities",
      workType: "book"
    });
  });

  it("opens the manual editor for a freshly created manual work", async () => {
    const onManageContent = vi.fn();
    mockedCreateWork.mockResolvedValue(essayWorkItem);
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // A manual Work is created with a canonical empty document (#720): the page navigates straight to
    // its manual editor rather than opening the imported-content panel.
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/library/works/work-1/edit");
    });
    expect(onManageContent).not.toHaveBeenCalled();
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
      screen.getByLabelText("Language")
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
        origin: "imported",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      result: {
        content: { readingUnits: [], workEntryId: epubWork.work.entryId },
        work: epubWork.work
      },
      status: "created"
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
        origin: "imported",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      result: {
        content: { readingUnits: [], workEntryId: epubWork.work.entryId },
        work: epubWork.work
      },
      status: "created"
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

  it("reopens the existing Work when identical EPUB bytes are re-uploaded (#706)", async () => {
    const onManageContent = vi.fn();
    // Re-uploading the same bytes returns the already-claimed Work (exact_existing): the learner is told
    // it is already in the library and dropped straight into Manage content, mirroring the Markdown front
    // door — no duplicate Work is created.
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      author: epubAuthor,
      work: {
        authorId: epubAuthor.id,
        entryId: toEntryId("work-epub"),
        language: "zh-CN",
        origin: "imported",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      result: {
        content: { readingUnits: [], workEntryId: epubWork.work.entryId },
        work: epubWork.work
      },
      status: "exact_existing"
    });
    mockedFetchWorks.mockResolvedValue({ works: [epubWork] });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-epub");
    });
    expect(
      await screen.findByText("“史记选读” is already in your library — opened it.")
    ).toBeDefined();
    expect(mockedCreateWork).not.toHaveBeenCalled();
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

  it("opens the OS file picker from the Add menu's Upload file action", async () => {
    const user = await renderReady();
    const input = screen.getByLabelText("Upload") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});

    const menu = await openAddMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Upload file/ }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("ingests a selected EPUB directly without showing the Add-work form", async () => {
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      author: epubAuthor,
      work: {
        authorId: epubAuthor.id,
        entryId: toEntryId("work-epub"),
        language: "zh-CN",
        origin: "imported",
        title: "史记选读",
        workType: "book"
      }
    };
    mockedIngestEpub.mockResolvedValue({
      result: {
        content: { readingUnits: [], workEntryId: epubWork.work.entryId },
        work: epubWork.work
      },
      status: "created"
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

  it("prefills the Add-work sheet from a Markdown filename, then mints the Work in one atomic import (#706)", async () => {
    const onManageContent = vi.fn();
    // The front-door Markdown lane now mints the Work, its retained source, and its single-owner claim
    // in one request (#706) rather than createWork + a separate ingest, so a re-upload can reopen the
    // existing Work instead of orphaning an empty shell. createWork must not be touched for Markdown.
    mockedImportMarkdownWork.mockResolvedValue({
      result: {
        content: { readingUnits: [], workEntryId: essayWorkItem.work.entryId },
        work: essayWorkItem.work
      },
      status: "created"
    });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const file = new File(["# Politics"], "Politics and the English Language.md", {
      type: "text/markdown"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Politics and the English Language");
    expect(mockedImportMarkdownWork).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedImportMarkdownWork).toHaveBeenCalledWith({
        author: { mode: "new", name: "George Orwell" },
        fileName: "Politics and the English Language.md",
        language: "en",
        markdown: "# Politics",
        title: "Politics and the English Language",
        workType: "book"
      });
    });
    expect(mockedCreateWork).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
    expect(await screen.findByText("Imported “Politics and the English Language”.")).toBeDefined();
  });

  it("reopens the existing Work when identical Markdown bytes are re-uploaded (#706)", async () => {
    const onManageContent = vi.fn();
    // Re-uploading the same bytes returns the already-claimed Work (exact_existing); the learner is told
    // it is already in the library and dropped straight into Manage content, with no duplicate created.
    mockedImportMarkdownWork.mockResolvedValue({
      result: {
        content: { readingUnits: [], workEntryId: essayWorkItem.work.entryId },
        work: essayWorkItem.work
      },
      status: "exact_existing"
    });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const file = new File(["# Politics"], "Politics and the English Language.md", {
      type: "text/markdown"
    });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
    expect(
      await screen.findByText(
        "“Politics and the English Language” is already in your library — opened it."
      )
    ).toBeDefined();
    expect(mockedCreateWork).not.toHaveBeenCalled();
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
        origin: "imported",
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

  it("surfaces the Manage-content empty-content message when a Markdown upload has no readable text (#673)", async () => {
    const onManageContent = vi.fn();
    // The combined import endpoint reports empty_content and creates no Work (#706), so no orphan shell
    // is opened; the learner just sees the panel's Markdown copy and can pick a different file.
    mockedImportMarkdownWork.mockResolvedValue({ status: "empty_content" });
    const user = await renderReady(onManageContent);

    const file = new File(["![only image](x.png)"], "images.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // The Library upload lane must read identically to the Manage-content panel: "Markdown", not the
    // generic "document" wording used for PDFs. Before #673 it reused the PDF message, so the learner
    // was dropped into an empty Work with a message that never matched the panel's copy.
    expect(
      await screen.findByText(
        "This Markdown has no readable text to add. Images on their own aren’t supported yet."
      )
    ).toBeDefined();
    expect(
      screen.queryByText(
        "This document has no readable text to add. Images on their own aren’t supported yet."
      )
    ).toBeNull();
    // No Work is minted for empty Markdown, so Manage content is never opened.
    expect(onManageContent).not.toHaveBeenCalled();
  });

  it("shows a generic error toast when the Markdown import request throws", async () => {
    const onManageContent = vi.fn();
    mockedImportMarkdownWork.mockRejectedValue(new Error("network down"));
    const user = await renderReady(onManageContent);

    const file = new File(["# Politics"], "politics.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not ingest the file. Please try again.")).toBeDefined();
    expect(onManageContent).not.toHaveBeenCalled();
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

    // A fresh, purely-manual Add work must not import the previously held Markdown file.
    const menu = await openAddMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Add work manually" }));
    await screen.findByLabelText("Title");
    await user.type(screen.getByLabelText("Title"), "Manual Work");
    await user.type(screen.getByLabelText("New author or source name"), "Someone");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/library/works/work-1/edit");
    });
    expect(mockedImportMarkdownWork).not.toHaveBeenCalled();
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
      result: {
        content: { readingUnits: [], workEntryId: toEntryId("work-epub") },
        work: {
          authorId: toAuthorId("author-9"),
          entryId: toEntryId("work-epub"),
          language: "en",
          origin: "imported",
          title: "Book",
          workType: "book"
        }
      },
      status: "created"
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

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    await user.click(within(overflow).getByRole("menuitem", { name: "Delete work" }));

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

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    await user.click(within(overflow).getByRole("menuitem", { name: "Delete work" }));
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

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    await user.click(within(overflow).getByRole("menuitem", { name: "Delete work" }));
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

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    await user.click(within(overflow).getByRole("menuitem", { name: "Delete work" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete work" });
    await user.click(within(dialog).getByRole("button", { name: "Delete work" }));

    expect(await screen.findByText("Could not delete the work. Please try again.")).toBeDefined();
    // The confirm dialog stays open (the work was not removed).
    expect(screen.getByRole("dialog", { name: "Delete work" })).toBeDefined();
  });

  it("marks a Work authored with a badge, keeps the shared read action, and moves Edit in Writing into overflow with no Markdown export (#576, #640, #679)", async () => {
    const authoredEssayItem: WorkListItemDto = {
      ...essayWorkItem,
      work: { ...essayWorkItem.work, origin: "authored" }
    };
    mockedFetchWorks.mockResolvedValue({ works: [authoredEssayItem, animalFarmItem] });
    const user = await renderReady();

    const group = await screen.findByRole("region", { name: "George Orwell" });
    const authoredCard = within(group)
      .getByRole("heading", { name: "Politics and the English Language" })
      .closest("li");
    expect(authoredCard).not.toBeNull();
    const authored = within(authoredCard as HTMLElement);
    // The authored badge plus the same shared-reader Read link imported works use (selection → notes,
    // search deep-links). Edit and Notes move off the card face into the overflow menu.
    expect(authored.getByText("Authored")).toBeDefined();
    expect(authored.getByRole("link", { name: "Read" }).getAttribute("href")).toBe(
      "#/reader?work=work-1"
    );
    expect(authored.queryByRole("menuitem", { name: "Edit in Writing" })).toBeNull();

    const authoredOverflow = await openWorkOverflow(user, "Politics and the English Language");
    // Authored Works edit in the rich editor — never a "Manage content" surface — and never expose a
    // Markdown export.
    expect(
      within(authoredOverflow)
        .getByRole("menuitem", { name: "Edit in Writing" })
        .getAttribute("href")
    ).toBe("#/write?work=work-1");
    expect(
      within(authoredOverflow).getByRole("menuitem", { name: "View notes" }).getAttribute("href")
    ).toBe("#/notes?work=work-1");
    expect(within(authoredOverflow).queryByRole("menuitem", { name: "Manage content" })).toBeNull();
    expect(
      within(authoredOverflow).queryByRole("menuitem", { name: "Export Markdown" })
    ).toBeNull();
    await user.keyboard("{Escape}");

    // A non-authored Work keeps the reader flow and Manage content, but likewise has no Markdown export.
    const importedCard = within(group).getByRole("heading", { name: "Animal Farm" }).closest("li");
    const imported = within(importedCard as HTMLElement);
    expect(imported.queryByText("Authored")).toBeNull();
    expect(imported.getByRole("link", { name: "Read" }).getAttribute("href")).toBe(
      "#/reader?work=work-2"
    );
    const importedOverflow = await openWorkOverflow(user, "Animal Farm");
    expect(
      within(importedOverflow).getByRole("menuitem", { name: "Manage content" })
    ).toBeDefined();
    expect(
      within(importedOverflow).queryByRole("menuitem", { name: "Edit in Writing" })
    ).toBeNull();
    expect(
      within(importedOverflow).queryByRole("menuitem", { name: "Export Markdown" })
    ).toBeNull();
  });

  const recitationPlanFor = (workEntryId: string, title: string): RecitationPlanDto => ({
    createdAt: "2026-07-01T09:00:00.000Z",
    entryId: `plan-${workEntryId}`,
    lastSessionAt: null,
    phase: "maintenance",
    sessionCount: 0,
    updatedAt: "2026-07-01T09:00:00.000Z",
    workEntryId,
    workTitle: title
  });

  it("enrolls a Work with 'I can recite this' from overflow, then offers Open in Recite (#640, #643)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedEnrollRecitation.mockResolvedValue(
      recitationPlanFor("work-1", "Politics and the English Language")
    );
    // The reload after enrolling reports the new plan so the overflow flips to "Open in Recite".
    mockedListRecitationPlans.mockResolvedValueOnce({ plans: [] }).mockResolvedValue({
      plans: [recitationPlanFor("work-1", "Politics and the English Language")]
    });
    const user = await renderReady();

    // There is no phase picker (#643): the action enrolls straight into maintenance — the learner's
    // explicit declaration that the Work is retrievable — with no Familiarizing/Learning/Maintenance choice.
    expect(screen.queryByRole("button", { name: "Practise recitation" })).toBeNull();
    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    // Retired passage-segmentation controls never appear in Library.
    expect(within(overflow).queryByRole("menuitem", { name: "Divide into passages" })).toBeNull();
    expect(within(overflow).queryByRole("menuitem", { name: "Set up passages" })).toBeNull();
    await user.click(within(overflow).getByRole("menuitem", { name: "I can recite this" }));

    await waitFor(() => {
      expect(mockedEnrollRecitation).toHaveBeenCalledWith("work-1");
    });
    // Enrollment persists, then the exact Work's whole-Work review opens scoped to `?work=` (#643).
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/recitation?work=work-1");
    });

    // The card face carries no recitation status (Recite owns it); the enrolled Work now offers only
    // "Open in Recite" — the enroll action is gone.
    expect(screen.queryByText("Reciting")).toBeNull();
    const reopened = await openWorkOverflow(user, "Politics and the English Language");
    expect(
      within(reopened).getByRole("menuitem", { name: "Open in Recite" }).getAttribute("href")
    ).toBe("#/recite");
    expect(within(reopened).queryByRole("menuitem", { name: "I can recite this" })).toBeNull();
  });

  it("offers Open in Recite (not enrol, no face status) for an already-enrolled Work (#640, #643)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedListRecitationPlans.mockResolvedValue({
      plans: [recitationPlanFor("work-1", "Politics and the English Language")]
    });
    const user = await renderReady();

    // No recitation phase/status/due state leaks onto the card face — Recite owns all of it.
    expect(screen.queryByText("Reciting")).toBeNull();
    expect(screen.queryByText(/Reciting · /)).toBeNull();
    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    expect(within(overflow).queryByRole("menuitem", { name: "I can recite this" })).toBeNull();
    expect(within(overflow).queryByRole("menuitem", { name: "Divide into passages" })).toBeNull();
    expect(
      within(overflow).getByRole("menuitem", { name: "Open in Recite" }).getAttribute("href")
    ).toBe("#/recite");
  });

  it("surfaces an error and does not navigate when enrolling fails (#643)", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    mockedEnrollRecitation.mockRejectedValue(new Error("boom"));
    const user = await renderReady();

    const overflow = await openWorkOverflow(user, "Politics and the English Language");
    await user.click(within(overflow).getByRole("menuitem", { name: "I can recite this" }));

    expect(
      await screen.findByText("Could not start reciting this work. Please try again.")
    ).toBeDefined();
    expect(navigateSpy).not.toHaveBeenCalled();
    // The action stays available so the learner can retry.
    const reopened = await openWorkOverflow(user, "Politics and the English Language");
    expect(within(reopened).getByRole("menuitem", { name: "I can recite this" })).toBeDefined();
  });
});
