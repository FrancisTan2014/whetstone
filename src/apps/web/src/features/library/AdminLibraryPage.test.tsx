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
  beginEpubCreation: vi.fn(),
  beginManualCreation: vi.fn(),
  beginMarkdownCreation: vi.fn(),
  cancelWorkCreation: vi.fn(),
  deleteWork: vi.fn(),
  fetchWorks: vi.fn(),
  fetchWorksWithReadingPosition: vi.fn(),
  keepSeparateWork: vi.fn(),
  openExistingWork: vi.fn(),
  searchAuthors: vi.fn()
}));

// The real create-or-select combobox is exercised in AuthorSelectField.test.tsx; here we stub it to a
// minimal control that drives `onSelectionChange` directly, so page-level tests assert the form's own
// behavior (validation, submit payload, reset, sheet lifecycle) without the debounced search/listbox. It
// reports the resolved display name as the second argument, mirroring the real field (#702).
vi.mock("./AuthorSelectField", () => ({
  AuthorSelectField: ({
    onSelectionChange
  }: {
    onSelectionChange: (selection: WorkAuthorSelection | undefined, name?: string) => void;
  }) => (
    <label>
      New author or source name
      <input
        aria-label="New author or source name"
        onChange={(event) => {
          const value = (event.target as HTMLInputElement).value;
          onSelectionChange(
            value === "" ? undefined : { mode: "new", name: value },
            value === "" ? undefined : value
          );
        }}
      />
      <button
        onClick={() =>
          onSelectionChange(
            { authorId: "author-2", mode: "existing" } as WorkAuthorSelection,
            "Charles Dickens"
          )
        }
        type="button"
      >
        Use existing author
      </button>
    </label>
  )
}));

vi.mock("../pdfImport/pdfImportApi", () => ({
  beginPdfImport: vi.fn(),
  cancelPdfImport: vi.fn(),
  fetchPdfImportView: vi.fn(),
  retryPdfImport: vi.fn()
}));

vi.mock("../pdfImport/pdfImportSession", () => ({
  forgetActivePdfImport: vi.fn(),
  readActivePdfImport: vi.fn(() => null),
  rememberActivePdfImport: vi.fn()
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
  beginEpubCreation,
  beginManualCreation,
  beginMarkdownCreation,
  cancelWorkCreation,
  deleteWork,
  fetchWorks,
  fetchWorksWithReadingPosition,
  keepSeparateWork,
  openExistingWork,
  searchAuthors
} from "./libraryApi";
import {
  beginPdfImport,
  cancelPdfImport,
  fetchPdfImportView,
  retryPdfImport
} from "../pdfImport/pdfImportApi";
import {
  forgetActivePdfImport,
  readActivePdfImport,
  rememberActivePdfImport
} from "../pdfImport/pdfImportSession";
import { enrollRecitation, listRecitationPlans } from "../recitation/recitationApi";
import { AdminLibraryPage } from "./AdminLibraryPage";
import { ToastProvider } from "../../shared/ui/toast/ToastProvider";
import { ToastViewport } from "../../shared/ui/toast/ToastViewport";
import { MemoryRouter } from "react-router-dom";
import type {
  AuthorDto,
  PdfImportStatusDto,
  PdfImportViewDto,
  RecitationPlanDto,
  WorkAuthorSelection,
  WorkCreationReviewDto,
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
const mockedDeleteWork = vi.mocked(deleteWork);
const mockedBeginEpubCreation = vi.mocked(beginEpubCreation);
const mockedBeginManualCreation = vi.mocked(beginManualCreation);
const mockedBeginMarkdownCreation = vi.mocked(beginMarkdownCreation);
const mockedCancelWorkCreation = vi.mocked(cancelWorkCreation);
const mockedKeepSeparateWork = vi.mocked(keepSeparateWork);
const mockedOpenExistingWork = vi.mocked(openExistingWork);
const mockedBeginPdfImport = vi.mocked(beginPdfImport);
const mockedCancelPdfImport = vi.mocked(cancelPdfImport);
const mockedFetchPdfImportView = vi.mocked(fetchPdfImportView);
const mockedRetryPdfImport = vi.mocked(retryPdfImport);
const mockedRememberActivePdfImport = vi.mocked(rememberActivePdfImport);
const mockedForgetActivePdfImport = vi.mocked(forgetActivePdfImport);
const mockedReadActivePdfImport = vi.mocked(readActivePdfImport);
const mockedListRecitationPlans = vi.mocked(listRecitationPlans);
const mockedEnrollRecitation = vi.mocked(enrollRecitation);

const orwell: AuthorDto = { id: toAuthorId("author-1"), name: "George Orwell" };
const dickens: AuthorDto = { id: toAuthorId("author-2"), name: "Charles Dickens" };

const essayWorkItem: WorkListItemDto = {
  correctable: false,
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
  correctable: false,
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

// A begin/decision `needs_review` payload: one credible candidate against the learner's proposal. The
// panel holds only the opaque attempt id + revision from this DTO and sends a semantic decision.
function duplicateReview(revision = 0): WorkCreationReviewDto {
  return {
    attemptId: "attempt-1",
    candidateFingerprint: `fp-${revision}`,
    candidates: [
      {
        author: { id: "author-1", name: "George Orwell" },
        entryId: "work-1",
        evidence: {
          editionMarkerDifferences: [],
          languageDiffers: false,
          sameAuthor: true,
          titleSimilarity: 0.94,
          workTypeDiffers: false
        },
        language: "en",
        matchTier: "same_author_fuzzy",
        origin: "imported",
        title: "Politics and the English Language",
        workType: "book"
      }
    ],
    proposed: {
      authorName: "George Orwell",
      language: "en",
      title: "Politics and the English Language",
      workType: "book"
    },
    revision,
    sourceFileName: "Politics and the English Language.md"
  };
}

const reopenResult = {
  content: { readingUnits: [], workEntryId: essayWorkItem.work.entryId },
  work: essayWorkItem.work
};

// A manual begin `created` outcome (#749): no credible candidate, so the owned empty-document Work is
// minted. Its `manual` origin routes completion into the Library's manual editor.
function manualCreated(work: WorkListItemDto["work"] = essayWorkItem.work) {
  const manualWork = { ...work, origin: "manual" as const };
  return {
    result: {
      content: { readingUnits: [], workEntryId: manualWork.entryId },
      work: manualWork
    },
    status: "created" as const
  };
}

// The EPUB counterpart of duplicateReview: a credible same-author candidate against the embedded OPF
// metadata. The panel is format-agnostic, so it frames the attempt by the derived `<title>.epub` label.
function duplicateEpubReview(revision = 0): WorkCreationReviewDto {
  return {
    attemptId: "attempt-epub-1",
    candidateFingerprint: `fp-epub-${revision}`,
    candidates: [
      {
        author: { id: "author-9", name: "司马迁" },
        entryId: "work-epub-existing",
        evidence: {
          editionMarkerDifferences: [],
          languageDiffers: false,
          sameAuthor: true,
          titleSimilarity: 0.95,
          workTypeDiffers: false
        },
        language: "zh-CN",
        matchTier: "same_author_fuzzy",
        origin: "imported",
        title: "史记选读",
        workType: "book"
      }
    ],
    proposed: {
      authorName: "司马迁",
      language: "zh-CN",
      title: "史记选读",
      workType: "book"
    },
    revision,
    sourceFileName: "史记选读.epub"
  };
}

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
  // No in-flight PDF import to resume by default; individual reopen tests override this.
  mockedReadActivePdfImport.mockReturnValue(null);
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

// Drive the Markdown front door to the duplicate-review panel: upload a `.md`, confirm the proposed
// author, and submit. The caller seeds `beginMarkdownCreation` with a `needs_review` outcome first.
async function reachReview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const file = new File(["# Politics"], "Politics and the English Language.md", {
    type: "text/markdown"
  });
  await user.upload(screen.getByLabelText("Upload"), file);
  await screen.findByLabelText("Title");
  await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
  await user.click(screen.getByRole("button", { name: "Create work" }));
  await screen.findByText("Possible duplicate");
}

// Drive the MANUAL front door to the duplicate-review panel (#749): open Add work manually, name the
// proposed author + title, and submit. The caller seeds `beginManualCreation` with a `needs_review`
// outcome first. There is no upload — manual review only weighs candidates for the typed metadata.
async function reachManualReview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openAddWork(user);
  await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
  await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
  await user.click(screen.getByRole("button", { name: "Create work" }));
  await screen.findByText("Possible duplicate");
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

    expect(mockedBeginManualCreation).not.toHaveBeenCalled();
  });

  it("offers exactly the three supported languages and submits the chosen code", async () => {
    const user = await renderReady();
    mockedBeginManualCreation.mockResolvedValue(manualCreated());
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
      expect(mockedBeginManualCreation).toHaveBeenCalledWith({
        author: { mode: "new", name: "吳楚材" },
        language: "zh-TW",
        title: "古文觀止",
        workType: "book"
      });
    });
  });

  it("creates a work with a new inline author and shows it grouped", async () => {
    const user = await renderReady();
    mockedBeginManualCreation.mockResolvedValue(manualCreated());
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
    expect(mockedBeginManualCreation).toHaveBeenCalledWith({
      author: { mode: "new", name: "George Orwell" },
      language: "en",
      title: "Politics and the English Language",
      workType: "essay"
    });
  });

  it("creates a work for an existing author chosen from the author field", async () => {
    const user = await renderReady();
    const bookItem: WorkListItemDto = {
      correctable: false,
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
    mockedBeginManualCreation.mockResolvedValue(manualCreated(bookItem.work));
    mockedFetchWorks.mockResolvedValue({ works: [bookItem] });
    await openAddWork(user);

    await user.click(screen.getByRole("button", { name: "Use existing author" }));
    await user.type(screen.getByLabelText("Title"), "A Tale of Two Cities");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByRole("heading", { name: "A Tale of Two Cities" })).toBeDefined();
    expect(mockedBeginManualCreation).toHaveBeenCalledWith({
      author: { authorId: dickens.id, mode: "existing" },
      language: "en",
      title: "A Tale of Two Cities",
      workType: "book"
    });
  });

  it("opens the manual editor for a freshly created manual work", async () => {
    const onManageContent = vi.fn();
    mockedBeginManualCreation.mockResolvedValue(manualCreated());
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
    mockedBeginManualCreation.mockRejectedValue(new Error("boom"));
    await openAddWork(user);

    await user.type(screen.getByLabelText("Title"), "Doomed");
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not save the work. Please try again.")).toBeDefined();
  });

  it("parks the shared review panel when a manual entry hits a credible candidate", async () => {
    mockedBeginManualCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    const user = await renderReady();

    await reachManualReview(user);

    const list = screen.getByRole("list", { name: "Possible duplicates" });
    expect(within(list).getByText("Politics and the English Language")).toBeDefined();
    // Nothing is created while the review is open.
    expect(mockedOpenExistingWork).not.toHaveBeenCalled();
    expect(mockedKeepSeparateWork).not.toHaveBeenCalled();
  });

  it("surfaces manual author-not-found and uncertain begin outcomes without creating a Work", async () => {
    const onManageContent = vi.fn();
    const user = await renderReady(onManageContent);

    for (const [status, message] of [
      ["author_not_found", "That author or source no longer exists. Choose another and try again."],
      ["uncertain", "Couldn’t check your library for duplicates just now. Please try again."]
    ] as const) {
      mockedBeginManualCreation.mockResolvedValue({ status });
      await openAddWork(user);
      await user.type(screen.getByLabelText("Title"), "Politics and the English Language");
      await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
      await user.click(screen.getByRole("button", { name: "Create work" }));

      expect(await screen.findByText(message)).toBeDefined();
      // The Add-work form stays open so the learner can adjust and retry; nothing was created.
      expect(screen.getByLabelText("Title")).toBeDefined();
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    }
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(onManageContent).not.toHaveBeenCalled();
  });

  it("commits a distinct manual Work and opens its editor when the learner keeps it separate", async () => {
    const onManageContent = vi.fn();
    mockedBeginManualCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedKeepSeparateWork.mockResolvedValue(manualCreated());
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    await reachManualReview(user);
    await user.click(screen.getByRole("button", { name: "Keep separate" }));

    await waitFor(() => {
      expect(mockedKeepSeparateWork).toHaveBeenCalledWith("attempt-1", { revision: 0 });
    });
    // A manual Keep separate is "Added" and routes into the manual editor, not Manage content (#749).
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/library/works/work-1/edit"));
    expect(await screen.findByText("Added “Politics and the English Language”.")).toBeDefined();
    expect(onManageContent).not.toHaveBeenCalled();
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
    let resolveCreate: (value: ReturnType<typeof manualCreated>) => void = () => {};
    mockedBeginManualCreation.mockImplementation(
      () =>
        new Promise<ReturnType<typeof manualCreated>>((resolve) => {
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
    expect(mockedBeginManualCreation).toHaveBeenCalledTimes(1);

    resolveCreate(manualCreated());
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Create work" })).toBeNull();
    });
  });

  it("ingests an EPUB upload and refreshes the grouped works", async () => {
    const user = await renderReady();
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      correctable: false,
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
    mockedBeginEpubCreation.mockResolvedValue({
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
    expect(mockedBeginEpubCreation).toHaveBeenCalledTimes(1);
  });

  it("does not open the manage-content surface after an EPUB import", async () => {
    const onManageContent = vi.fn();
    const epubAuthor: AuthorDto = { id: toAuthorId("author-9"), name: "司马迁" };
    const epubWork: WorkListItemDto = {
      correctable: false,
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
    mockedBeginEpubCreation.mockResolvedValue({
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
      correctable: false,
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
    mockedBeginEpubCreation.mockResolvedValue({
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
  });

  it("shows an error when the EPUB ingestion fails", async () => {
    const user = await renderReady();
    mockedBeginEpubCreation.mockRejectedValue(new Error("boom"));

    const file = new File([new Uint8Array([1])], "bad.epub", { type: "application/epub+zip" });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(await screen.findByText("Could not ingest the EPUB. Please try again.")).toBeDefined();
  });

  it("routes a credible EPUB duplicate into the shared review panel (#748)", async () => {
    const user = await renderReady();
    mockedBeginEpubCreation.mockResolvedValue({
      review: duplicateEpubReview(),
      status: "needs_review"
    });

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    // The same duplicate-review panel the Markdown front door shows — no EPUB-specific branch — framed by
    // the derived `<title>.epub` label, with the candidate Work listed for an Open existing / Keep separate
    // decision. Nothing is created until the learner decides.
    expect(await screen.findByText("Possible duplicate")).toBeDefined();
    const list = screen.getByRole("list", { name: "Possible duplicates" });
    expect(within(list).getByText("史记选读")).toBeDefined();
    expect(screen.getByText("史记选读.epub")).toBeDefined();
  });

  it("commits the EPUB as a separate Work from the review panel (#748)", async () => {
    const onManageContent = vi.fn();
    const user = await renderReady(onManageContent);
    mockedBeginEpubCreation.mockResolvedValue({
      review: duplicateEpubReview(),
      status: "needs_review"
    });
    const created = {
      content: { readingUnits: [], workEntryId: toEntryId("work-epub-new") },
      work: {
        authorId: toAuthorId("author-9"),
        entryId: toEntryId("work-epub-new"),
        language: "zh-CN" as const,
        origin: "imported" as const,
        title: "史记选读",
        workType: "book" as const
      }
    };
    mockedKeepSeparateWork.mockResolvedValue({ result: created, status: "created" });

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);
    await screen.findByText("Possible duplicate");
    await user.click(screen.getByRole("button", { name: "Keep separate" }));

    // The shared decision path lands the distinct Work: it drops the learner into Manage content, just as
    // the Markdown Keep separate does — the review UI never forks by source format.
    await waitFor(() => {
      expect(mockedKeepSeparateWork).toHaveBeenCalledWith("attempt-epub-1", { revision: 0 });
    });
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-epub-new");
    });
  });

  it("reports an unreadable EPUB without creating anything (#748)", async () => {
    const user = await renderReady();
    mockedBeginEpubCreation.mockResolvedValue({ status: "invalid_epub" });

    const file = new File([new Uint8Array([9])], "broken.epub", { type: "application/epub+zip" });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(
      await screen.findByText(
        "That file couldn’t be read as an EPUB. Please choose a valid .epub file."
      )
    ).toBeDefined();
  });

  it("reports an untrusted duplicate check for an EPUB and creates nothing (#748)", async () => {
    const user = await renderReady();
    mockedBeginEpubCreation.mockResolvedValue({ status: "uncertain" });

    const file = new File([new Uint8Array([1, 2, 3])], "shiji.epub", {
      type: "application/epub+zip"
    });
    await user.upload(screen.getByLabelText("Upload"), file);

    expect(
      await screen.findByText(
        "Couldn’t check your library for duplicates just now. Please try again."
      )
    ).toBeDefined();
  });

  it("ignores an upload with no file selected", async () => {
    await renderReady();

    fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [] } });

    expect(mockedBeginEpubCreation).not.toHaveBeenCalled();
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
      correctable: false,
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
    mockedBeginEpubCreation.mockResolvedValue({
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
  });

  it("routes by MIME type first: a PDF mislabelled .epub takes the PDF confirm path", async () => {
    const user = await renderReady();

    // Real content type is PDF even though the filename ends in .epub — MIME must win, so this opens
    // the PDF/Markdown confirm sheet rather than ingesting directly as an EPUB.
    const file = new File([new Uint8Array([1])], "mislabelled.epub", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("mislabelled");
    expect(mockedBeginEpubCreation).not.toHaveBeenCalled();
  });

  it("prefills the Add-work sheet from a Markdown filename, then mints the Work in one atomic import (#706)", async () => {
    const onManageContent = vi.fn();
    // The front-door Markdown lane now mints the Work, its retained source, and its single-owner claim
    // in one request (#706) rather than createWork + a separate ingest, so a re-upload can reopen the
    // existing Work instead of orphaning an empty shell. createWork must not be touched for Markdown.
    mockedBeginMarkdownCreation.mockResolvedValue({
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
    expect(mockedBeginMarkdownCreation).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedBeginMarkdownCreation).toHaveBeenCalledWith({
        author: { mode: "new", name: "George Orwell" },
        fileName: "Politics and the English Language.md",
        language: "en",
        markdown: "# Politics",
        title: "Politics and the English Language",
        workType: "book"
      });
    });
    await waitFor(() => {
      expect(onManageContent).toHaveBeenCalledWith("work-1");
    });
    expect(await screen.findByText("Imported “Politics and the English Language”.")).toBeDefined();
  });

  it("reopens the existing Work when identical Markdown bytes are re-uploaded (#706)", async () => {
    const onManageContent = vi.fn();
    // Re-uploading the same bytes returns the already-claimed Work (exact_existing); the learner is told
    // it is already in the library and dropped straight into Manage content, with no duplicate created.
    mockedBeginMarkdownCreation.mockResolvedValue({
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
  });

  // A #721 execution status; overrides tailor the specific branch. `sourceHash` must be 64 hex chars.
  function pdfStatus(overrides: Partial<PdfImportStatusDto> = {}): PdfImportStatusDto {
    return {
      adapterFingerprint: null,
      attemptId: "attempt-1",
      completedPages: 0,
      completedRanges: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      failure: null,
      heartbeatAt: null,
      phase: null,
      sourceHash: "a".repeat(64),
      stage: { bound: true },
      state: "queued",
      totalPages: null,
      totalRanges: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides
    };
  }

  function pdfView(
    publication: PdfImportViewDto["publication"],
    statusOverrides: Partial<PdfImportStatusDto> = {}
  ): PdfImportViewDto {
    return { publication, review: null, status: pdfStatus(statusOverrides) };
  }

  it("imports a born-digital PDF: forwards the entered metadata, then opens the published Work in the Reader (#702)", async () => {
    const onManageContent = vi.fn();
    // No shell Work is created up front: the import mints its canonical Work atomically and publishes it.
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({
        status: "published",
        unresolvedFigureCount: 0,
        headingLevelSources: { label: 0, outline: 0 },
        workEntryId: "work-1"
      })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1, 2, 3])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);

    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Report");

    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // The learner's upload-time intent (title/author/language + provenance file name) rides with the bytes.
    // With no explicit scanned-text choice, the override is null so the server falls back to the work language.
    await waitFor(() => {
      expect(mockedBeginPdfImport).toHaveBeenCalledWith(file, {
        enteredAuthor: "Nobody",
        enteredLanguage: "en",
        enteredTitle: "Report",
        fileName: "Report.pdf",
        ocrLanguageOverride: null
      });
    });
    // No legacy shell-Work create for a born-digital PDF.
    // The in-flight attempt is remembered so it survives navigation, then cleared on completion.
    expect(mockedRememberActivePdfImport).toHaveBeenCalledWith("attempt-1");
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/reader?work=work-1");
    });
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
    expect(await screen.findByText("Your PDF is ready to read.")).toBeDefined();
    // The Reader is the destination, not the Manage-content panel.
    expect(onManageContent).not.toHaveBeenCalled();
  });

  it("opens a PDF published with unresolved figures and reports the figure-review workload (#806)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({
        status: "published",
        unresolvedFigureCount: 2,
        headingLevelSources: { label: 0, outline: 0 },
        workEntryId: "work-1"
      })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    const file = new File([new Uint8Array([1, 2, 3])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // The readable text still publishes and opens; the toast names how many figures need an image.
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/reader?work=work-1");
    });
    expect(await screen.findByText("Imported with 2 figures to review.")).toBeDefined();
  });

  it("reports the outline-gap warning on a published PDF whose headings came from labels (#870)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({
        status: "published",
        unresolvedFigureCount: 0,
        headingLevelSources: { label: 2, outline: 0 },
        workEntryId: "work-gap"
      })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    const file = new File([new Uint8Array([1, 2, 3])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // The book still publishes and opens; the toast warns that the headings came from labels because
    // the PDF carried no outline, so an administrator knows the structure will need manual correction.
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/reader?work=work-gap");
    });
    expect(
      await screen.findByText("Imported with 2 headings from labels (no outline).")
    ).toBeDefined();
  });

  it("sends the chosen scanned-text language as the OCR override for a held PDF (#746)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({
        status: "published",
        unresolvedFigureCount: 0,
        headingLevelSources: { label: 0, outline: 0 },
        workEntryId: "work-1"
      })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    const file = new File([new Uint8Array([1, 2, 3])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    // The scanned-text language control only appears for a held PDF and drives the OCR override.
    await user.selectOptions(screen.getByLabelText("Scanned-text language"), "zh-CN");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedBeginPdfImport).toHaveBeenCalledWith(file, {
        enteredAuthor: "Nobody",
        enteredLanguage: "en",
        enteredTitle: "Report",
        fileName: "Report.pdf",
        ocrLanguageOverride: "zh-CN"
      });
    });
  });

  it("reopens the existing Work when identical PDF bytes are re-uploaded, with no new attempt (#706)", async () => {
    mockedBeginPdfImport.mockResolvedValue({ outcome: "reopened", workEntryId: "work-1" });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/reader?work=work-1");
    });
    expect(
      await screen.findByText("“Report” is already in your library — opening it.")
    ).toBeDefined();
    // A reopen never polls a new attempt.
    expect(mockedFetchPdfImportView).not.toHaveBeenCalled();
    expect(mockedRememberActivePdfImport).not.toHaveBeenCalled();
  });

  it("refuses an English PDF whose OCR left text-less pages and publishes no Work (#745)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({ pagesNeedingOcr: 1, status: "ocr_validation_failed" })
    );
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "scan.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(
      await screen.findByText(/Some pages could not be read even after text recognition/)
    ).toBeDefined();
    // No Work is published, so the Reader is never opened.
    expect(navigateSpy).not.toHaveBeenCalledWith(expect.stringContaining("/reader"));
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
  });

  it("refuses a no-readable-content PDF with the empty-document message and publishes no Work (#702)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(pdfView({ status: "no_content" }));
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "blank.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText(/no readable text content to import/)).toBeDefined();
    // No Work is published, so the Reader is never opened.
    expect(navigateSpy).not.toHaveBeenCalledWith(expect.stringContaining("/reader"));
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
  });

  it("surfaces the adapter's named failure when the conversion fails (#702)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView(
        { status: "pending" },
        {
          failure: {
            kind: "unreadable_source",
            message: "The converter could not read this PDF.",
            remedy: "Try exporting the PDF again."
          },
          state: "failed"
        }
      )
    );
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "broken.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("The converter could not read this PDF.")).toBeDefined();
    expect(navigateSpy).not.toHaveBeenCalledWith(expect.stringContaining("/reader"));
  });

  it("routes a converted PDF that hits a credible duplicate into the shared review panel (#750)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    // The first poll after conversion parked the shared review: the view carries the minted review DTO with
    // the attempt still `awaiting_review` (it keeps its bytes while the learner decides — nothing published).
    mockedFetchPdfImportView.mockResolvedValue({
      publication: { status: "pending" },
      review: duplicateReview(),
      status: pdfStatus({ state: "awaiting_review" })
    });
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "meditations.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // The SAME shared duplicate-review panel the Markdown/EPUB/manual front doors show — no PDF-specific
    // duplicate UI — framed by the review's own evidence.
    const list = await screen.findByRole("list", { name: "Possible duplicates" });
    expect(within(list).getByText("Politics and the English Language")).toBeDefined();
    // Nothing is published while the review is open, so the Reader is never opened.
    expect(navigateSpy).not.toHaveBeenCalledWith(expect.stringContaining("/reader"));
    // The converted attempt is parked, not discarded: it stays remembered so Back/expiry (and a reload) can
    // resume its `awaiting_review` poll for a fresh review instead of orphaning the expensive conversion.
    expect(mockedRememberActivePdfImport).toHaveBeenCalledWith("attempt-1");
    expect(mockedForgetActivePdfImport).not.toHaveBeenCalled();
  });

  it("re-reviews the converted PDF when the learner goes Back — the attempt is never orphaned (#750)", async () => {
    // The PDF import attempt and the work-creation review attempt are DISTINCT ids: Back cancels the review
    // attempt, but the converted PDF import must stay alive and re-reviewable.
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "pdf-attempt-1",
      outcome: "queued",
      status: pdfStatus({ attemptId: "pdf-attempt-1" })
    });
    const pdfReview: WorkCreationReviewDto = { ...duplicateReview(), attemptId: "wc-attempt-1" };
    // Every poll of the converted attempt reports it parked at `awaiting_review` with a minted review, so a
    // resumed poll after Back re-surfaces the shared panel.
    mockedFetchPdfImportView.mockResolvedValue({
      publication: { status: "pending" },
      review: pdfReview,
      status: pdfStatus({ attemptId: "pdf-attempt-1", state: "awaiting_review" })
    });
    mockedCancelWorkCreation.mockResolvedValue({ cancelled: true });
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "meditations.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await screen.findByRole("list", { name: "Possible duplicates" });

    await user.click(screen.getByRole("button", { name: "Back" }));

    // Back cancels the spent work-creation review attempt (not the PDF import) so the server hands the PDF
    // back as a fresh review…
    await waitFor(() => expect(mockedCancelWorkCreation).toHaveBeenCalledWith("wc-attempt-1"));
    // …then resumes the poll on the still-remembered PDF import attempt, which re-parks the shared panel.
    await waitFor(() => expect(mockedFetchPdfImportView).toHaveBeenCalledWith("pdf-attempt-1"));
    expect(await screen.findByRole("list", { name: "Possible duplicates" })).toBeDefined();
    // The converted attempt is never forgotten while it is still re-reviewable.
    expect(mockedForgetActivePdfImport).not.toHaveBeenCalled();
  });

  it("re-reviews the converted PDF when the review lapses instead of dropping to the form (#750)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "pdf-attempt-1",
      outcome: "queued",
      status: pdfStatus({ attemptId: "pdf-attempt-1" })
    });
    const pdfReview: WorkCreationReviewDto = { ...duplicateReview(), attemptId: "wc-attempt-1" };
    mockedFetchPdfImportView.mockResolvedValue({
      publication: { status: "pending" },
      review: pdfReview,
      status: pdfStatus({ attemptId: "pdf-attempt-1", state: "awaiting_review" })
    });
    // The decision fences on an expired attempt: a held-file review would fall back to the Add-work form, but
    // a PDF must resume its parked poll and re-mint a fresh review.
    mockedKeepSeparateWork.mockResolvedValue({ status: "expired" });
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "meditations.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await screen.findByRole("list", { name: "Possible duplicates" });
    await user.click(screen.getByRole("button", { name: "Keep separate" }));

    expect(
      await screen.findByText("This review is no longer valid. Please try again.")
    ).toBeDefined();
    // No Add-work form appears; the converted attempt resumes its poll and the panel re-mints instead.
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(await screen.findByRole("list", { name: "Possible duplicates" })).toBeDefined();
  });

  it("forgets the converted PDF once a review decision resolves it (#750)", async () => {
    const onManageContent = vi.fn();
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "pdf-attempt-1",
      outcome: "queued",
      status: pdfStatus({ attemptId: "pdf-attempt-1" })
    });
    const pdfReview: WorkCreationReviewDto = { ...duplicateReview(), attemptId: "wc-attempt-1" };
    mockedFetchPdfImportView.mockResolvedValue({
      publication: { status: "pending" },
      review: pdfReview,
      status: pdfStatus({ attemptId: "pdf-attempt-1", state: "awaiting_review" })
    });
    mockedOpenExistingWork.mockResolvedValue({ result: reopenResult, status: "opened" });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    const file = new File([new Uint8Array([1])], "meditations.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await screen.findByRole("list", { name: "Possible duplicates" });
    await user.click(
      screen.getByRole("button", { name: "Open existing “Politics and the English Language”" })
    );

    await waitFor(() =>
      expect(mockedOpenExistingWork).toHaveBeenCalledWith("wc-attempt-1", {
        entryId: "work-1",
        revision: 0
      })
    );
    await waitFor(() => expect(onManageContent).toHaveBeenCalledWith("work-1"));
    // The resolved decision consumed both attempts, so the remembered PDF import is dropped — a later reload
    // must not resume a spent import.
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
  });

  it("still re-reviews the converted PDF when Back's best-effort cleanup fails (#750)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "pdf-attempt-1",
      outcome: "queued",
      status: pdfStatus({ attemptId: "pdf-attempt-1" })
    });
    const pdfReview: WorkCreationReviewDto = { ...duplicateReview(), attemptId: "wc-attempt-1" };
    mockedFetchPdfImportView.mockResolvedValue({
      publication: { status: "pending" },
      review: pdfReview,
      status: pdfStatus({ attemptId: "pdf-attempt-1", state: "awaiting_review" })
    });
    // Cancelling the spent review attempt fails, but a converted PDF must never be stranded by a failed
    // cleanup: the poll still resumes on the remembered attempt and re-mints the review.
    mockedCancelWorkCreation.mockRejectedValue(new Error("cleanup failed"));
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "meditations.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await screen.findByRole("list", { name: "Possible duplicates" });
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(mockedCancelWorkCreation).toHaveBeenCalledWith("wc-attempt-1"));
    expect(await screen.findByRole("list", { name: "Possible duplicates" })).toBeDefined();
    expect(mockedForgetActivePdfImport).not.toHaveBeenCalled();
  });

  it("surfaces a start failure when the import cannot be queued (#702)", async () => {
    mockedBeginPdfImport.mockRejectedValue(new Error("network down"));
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not start the import. Please try again.")).toBeDefined();
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
  });

  it("surfaces the Manage-content empty-content message when a Markdown upload has no readable text (#673)", async () => {
    const onManageContent = vi.fn();
    // The combined import endpoint reports empty_content and creates no Work (#706), so no orphan shell
    // is opened; the learner just sees the panel's Markdown copy and can pick a different file.
    mockedBeginMarkdownCreation.mockResolvedValue({ status: "empty_content" });
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
    mockedBeginMarkdownCreation.mockRejectedValue(new Error("network down"));
    const user = await renderReady(onManageContent);

    const file = new File(["# Politics"], "politics.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Could not ingest the file. Please try again.")).toBeDefined();
    expect(onManageContent).not.toHaveBeenCalled();
  });

  it("surfaces the author-not-found and uncertain begin outcomes without creating a Work", async () => {
    const onManageContent = vi.fn();
    const user = await renderReady(onManageContent);

    for (const [status, message] of [
      ["author_not_found", "That author or source no longer exists. Choose another and try again."],
      ["uncertain", "Couldn’t check your library for duplicates just now. Please try again."]
    ] as const) {
      mockedBeginMarkdownCreation.mockResolvedValue({ status });
      const file = new File(["# Politics"], `${status}.md`, { type: "text/markdown" });
      await user.upload(screen.getByLabelText("Upload"), file);
      await screen.findByLabelText("Title");
      await user.type(screen.getByLabelText("New author or source name"), "George Orwell");
      await user.click(screen.getByRole("button", { name: "Create work" }));

      expect(await screen.findByText(message)).toBeDefined();
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    }
    expect(onManageContent).not.toHaveBeenCalled();
  });

  it("presents the duplicate-review panel with factual evidence when a credible candidate exists", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    const user = await renderReady();

    await reachReview(user);

    const list = screen.getByRole("list", { name: "Possible duplicates" });
    expect(within(list).getByText("Politics and the English Language")).toBeDefined();
    expect(within(list).getByText("Same author")).toBeDefined();
    // Nothing is created while the review is open.
    expect(mockedOpenExistingWork).not.toHaveBeenCalled();
    expect(mockedKeepSeparateWork).not.toHaveBeenCalled();
  });

  it("reopens the chosen candidate when the learner picks Open existing", async () => {
    const onManageContent = vi.fn();
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedOpenExistingWork.mockResolvedValue({ result: reopenResult, status: "opened" });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    await reachReview(user);
    await user.click(
      screen.getByRole("button", { name: "Open existing “Politics and the English Language”" })
    );

    await waitFor(() => {
      expect(mockedOpenExistingWork).toHaveBeenCalledWith("attempt-1", {
        entryId: "work-1",
        revision: 0
      });
    });
    await waitFor(() => expect(onManageContent).toHaveBeenCalledWith("work-1"));
    expect(
      await screen.findByText(
        "“Politics and the English Language” is already in your library — opened it."
      )
    ).toBeDefined();
  });

  it("commits a distinct Work when the learner keeps it separate", async () => {
    const onManageContent = vi.fn();
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedKeepSeparateWork.mockResolvedValue({ result: reopenResult, status: "created" });
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    const user = await renderReady(onManageContent);

    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Keep separate" }));

    await waitFor(() => {
      expect(mockedKeepSeparateWork).toHaveBeenCalledWith("attempt-1", { revision: 0 });
    });
    await waitFor(() => expect(onManageContent).toHaveBeenCalledWith("work-1"));
    expect(await screen.findByText("Imported “Politics and the English Language”.")).toBeDefined();
  });

  it("re-renders the panel against refreshed evidence when a decision changes the snapshot", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(0),
      status: "needs_review"
    });
    mockedKeepSeparateWork.mockResolvedValue({
      review: duplicateReview(1),
      status: "needs_review"
    });
    const user = await renderReady();

    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Keep separate" }));

    expect(
      await screen.findByText("The possible duplicates changed — please review again.")
    ).toBeDefined();
    // The panel stays open with the refreshed review; a follow-up decision fences on the new revision.
    mockedKeepSeparateWork.mockResolvedValue({ result: reopenResult, status: "created" });
    await user.click(screen.getByRole("button", { name: "Keep separate" }));
    await waitFor(() => {
      expect(mockedKeepSeparateWork).toHaveBeenLastCalledWith("attempt-1", { revision: 1 });
    });
  });

  it("keeps the panel open and warns when the chosen existing Work is gone or the recheck is uncertain", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    const user = await renderReady();

    await reachReview(user);

    mockedOpenExistingWork.mockResolvedValue({ status: "existing_gone" });
    await user.click(
      screen.getByRole("button", { name: "Open existing “Politics and the English Language”" })
    );
    expect(
      await screen.findByText("That work no longer exists. Choose another option.")
    ).toBeDefined();
    expect(screen.getByText("Possible duplicate")).toBeDefined();

    mockedKeepSeparateWork.mockResolvedValue({ status: "uncertain" });
    await user.click(screen.getByRole("button", { name: "Keep separate" }));
    expect(
      await screen.findByText("Couldn’t re-check your library just now. Please try again.")
    ).toBeDefined();
    expect(screen.getByText("Possible duplicate")).toBeDefined();
  });

  it("drops a spent review back to the still-filled form when the attempt expires", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedKeepSeparateWork.mockResolvedValue({ status: "expired" });
    const user = await renderReady();

    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Keep separate" }));

    expect(
      await screen.findByText("This review is no longer valid. Please try again.")
    ).toBeDefined();
    // The Add-work form reopens with the draft title preserved so the learner can retry.
    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Politics and the English Language");
  });

  it("shows an error toast when a decision request throws", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedOpenExistingWork.mockRejectedValue(new Error("offline"));
    mockedKeepSeparateWork.mockRejectedValue(new Error("offline"));
    const user = await renderReady();

    await reachReview(user);
    await user.click(
      screen.getByRole("button", { name: "Open existing “Politics and the English Language”" })
    );
    expect(
      await screen.findByText("Could not open the existing work. Please try again.")
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Keep separate" }));
    expect(await screen.findByText("Could not create the work. Please try again.")).toBeDefined();
  });

  it("cancels the attempt and preserves the draft when the learner goes Back", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedCancelWorkCreation.mockResolvedValue({ cancelled: true });
    const user = await renderReady();

    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(mockedCancelWorkCreation).toHaveBeenCalledWith("attempt-1"));
    // Back returns to the still-filled Add-work form; the draft title survives.
    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Politics and the English Language");
  });

  it("still returns to the form when Back's best-effort attempt cleanup fails", async () => {
    mockedBeginMarkdownCreation.mockResolvedValue({
      review: duplicateReview(),
      status: "needs_review"
    });
    mockedCancelWorkCreation.mockRejectedValue(new Error("cleanup failed"));
    const user = await renderReady();

    await reachReview(user);
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(mockedCancelWorkCreation).toHaveBeenCalledWith("attempt-1"));
    const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(titleInput.value).toBe("Politics and the English Language");
  });

  it("rejects an unsupported file type with an error and ingests nothing", async () => {
    await renderReady();

    const file = new File(["plain"], "notes.txt", { type: "text/plain" });
    // Bypass the input's accept filter to exercise the client-side type guard.
    fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [file] } });

    expect(await screen.findByText("Choose an .epub, .pdf, or .md file.")).toBeDefined();
    expect(mockedBeginEpubCreation).not.toHaveBeenCalled();
  });

  it("drops a held upload when the Add-work sheet is dismissed", async () => {
    const onManageContent = vi.fn();
    mockedBeginManualCreation.mockResolvedValue(manualCreated());
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
    expect(mockedBeginMarkdownCreation).not.toHaveBeenCalled();
  });

  it("shows the EPUB progress indicator while an EPUB ingests", async () => {
    let resolveIngest: (value: Awaited<ReturnType<typeof beginEpubCreation>>) => void = () => {};
    mockedBeginEpubCreation.mockImplementation(
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

  it("shows the born-digital import progress and lets the learner cancel it (#702)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    // The view stays in-flight so the progress card and Cancel action remain visible for the assertion.
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({ status: "pending" }, { state: "running", totalPages: null })
    );
    mockedCancelPdfImport.mockResolvedValue(null);
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    // The poll's projected label appears, and the escape hatch is offered.
    expect(await screen.findByText("Reading the PDF…")).toBeDefined();
    const cancelButton = await screen.findByRole("button", { name: "Cancel" });

    await user.click(cancelButton);

    expect(mockedCancelPdfImport).toHaveBeenCalledWith("attempt-1");
    expect(await screen.findByText("Import cancelled.")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText("Reading the PDF…")).toBeNull();
    });
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
  });

  it("surfaces a failed cancel instead of success-shaped feedback (#702)", async () => {
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    // The view stays in-flight so the progress card and Cancel action remain visible for the assertion.
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({ status: "pending" }, { state: "running", totalPages: null })
    );
    // The cancel request fails: the server import may still be running, so the UI must not claim success.
    mockedCancelPdfImport.mockRejectedValue(new Error("network"));
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    expect(await screen.findByText("Reading the PDF…")).toBeDefined();
    const cancelButton = await screen.findByRole("button", { name: "Cancel" });

    await user.click(cancelButton);

    expect(mockedCancelPdfImport).toHaveBeenCalledWith("attempt-1");
    expect(
      await screen.findByText("Could not cancel the import. It may still be running.")
    ).toBeDefined();
    expect(screen.queryByText("Import cancelled.")).toBeNull();
  });

  it("drops the session without opening the Reader when the polled attempt is gone (#702)", async () => {
    // A stale/removed attempt returns no view: polling reports `gone`, so the terminal handler just clears
    // the local session (no Work to open, no error toast).
    mockedBeginPdfImport.mockResolvedValue({
      attemptId: "attempt-1",
      outcome: "queued",
      status: pdfStatus()
    });
    mockedFetchPdfImportView.mockResolvedValue(null);
    const user = await renderReady();

    const file = new File([new Uint8Array([1])], "Report.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload"), file);
    await user.type(screen.getByLabelText("New author or source name"), "Nobody");
    await user.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => {
      expect(mockedForgetActivePdfImport).toHaveBeenCalled();
    });
    expect(navigateSpy).not.toHaveBeenCalledWith(expect.stringContaining("/reader"));
    expect(screen.queryByText("Your PDF is ready to read.")).toBeNull();
  });

  it("resumes an import left in flight when the Library is reopened (#702)", async () => {
    // A remembered attempt id (from a prior navigation) re-enters the poll loop on mount and completes.
    mockedReadActivePdfImport.mockReturnValue("attempt-1");
    mockedFetchPdfImportView.mockResolvedValue(
      pdfView({
        status: "published",
        unresolvedFigureCount: 0,
        headingLevelSources: { label: 0, outline: 0 },
        workEntryId: "work-1"
      })
    );
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/reader?work=work-1");
    });
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
  });

  it("re-queues an interrupted import on reopen so a crash-recovered import resumes (#702)", async () => {
    // A server restart/crash mid-conversion leaves the attempt `interrupted`; startup recovery parks it
    // there and the runner only advances `queued`. Reopening the Library must call the retry API to
    // requeue it — otherwise it shows "Import paused — resuming…" forever. Pre-fix, retry is never called
    // and the poll never reaches the published Work.
    mockedReadActivePdfImport.mockReturnValue("attempt-1");
    mockedFetchPdfImportView
      .mockResolvedValueOnce(pdfView({ status: "pending" }, { state: "interrupted" }))
      .mockResolvedValue(
        pdfView({
          status: "published",
          unresolvedFigureCount: 0,
          headingLevelSources: { label: 0, outline: 0 },
          workEntryId: "work-1"
        })
      );
    mockedRetryPdfImport.mockResolvedValue(pdfView({ status: "pending" }, { state: "queued" }));
    mockedFetchWorks.mockResolvedValue({ works: [essayWorkItem] });
    await renderReady();

    await waitFor(() => {
      expect(mockedRetryPdfImport).toHaveBeenCalledWith("attempt-1");
    });
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/reader?work=work-1");
    });
    expect(mockedForgetActivePdfImport).toHaveBeenCalled();
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
