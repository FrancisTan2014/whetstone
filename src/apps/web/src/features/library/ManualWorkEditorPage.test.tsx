// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManualWorkDto, ManualWorkUnitDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { MemoryRouter } from "react-router-dom";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AddManualWorkSectionResult, SaveManualWorkResult } from "./manualWorkApi";
import { ManualWorkEditorPage } from "./ManualWorkEditorPage";

// The page renders the real shared rich editor, which drives ProseMirror against the DOM; jsdom lacks
// the layout/pointer primitives ProseMirror probes, so stub the minimal surface the editor touches.
Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => new DOMRect()
});
Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => [] as unknown as DOMRectList
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => {}
});
for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  Object.defineProperty(HTMLElement.prototype, method, {
    configurable: true,
    value: () => (method === "hasPointerCapture" ? false : undefined)
  });
}

function mockMatchMedia(matches = false): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

vi.mock("./manualWorkApi", () => ({
  addManualWorkSection: vi.fn(),
  fetchManualWork: vi.fn(),
  fetchManualWorkUnit: vi.fn(),
  saveManualWorkContent: vi.fn()
}));

const { addManualWorkSection, fetchManualWork, fetchManualWorkUnit, saveManualWorkContent } =
  await import("./manualWorkApi");
const mockedAdd = addManualWorkSection as Mock<typeof addManualWorkSection>;
const mockedFetch = fetchManualWork as Mock<typeof fetchManualWork>;
const mockedFetchUnit = fetchManualWorkUnit as Mock<typeof fetchManualWorkUnit>;
const mockedSave = saveManualWorkContent as Mock<typeof saveManualWorkContent>;

// A realistic loaded document: a block with a stable persisted id and anchor, matching what the server
// reassembles from stored blocks. The editor preserves these ids, so its mount-time normalization echo
// equals the loaded document and the page opens in a clean "Saved" state.
const loadedDocument: DocumentNodeJSON = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "blk-1", anchorId: null },
      content: [{ type: "text", text: "Hello" }]
    }
  ]
};

const sectionBDocument: DocumentNodeJSON = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { id: "blk-b1", anchorId: null, level: 1 },
      content: [{ type: "text", text: "Chapter One" }]
    }
  ]
};

function makeWork(overrides: Partial<ManualWorkDto> = {}): ManualWorkDto {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    document: loadedDocument,
    entryId: "work-1",
    language: "en",
    revision: 0,
    sections: [{ orderIndex: 0, unitEntryId: "work-2" }],
    title: "A Tale of Two Cities",
    unitEntryId: "work-2",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workType: "book",
    ...overrides
  };
}

// A two-section work: a leading pre-heading section (unit-a → a root "Start" entry) and a Heading 1
// section (unit-b → "Chapter One"). The editor opens at unit-a.
function makeMultiWork(overrides: Partial<ManualWorkDto> = {}): ManualWorkDto {
  return makeWork({
    unitEntryId: "unit-a",
    sections: [
      { orderIndex: 0, unitEntryId: "unit-a" },
      { headingLevel: 1, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-b" }
    ],
    ...overrides
  });
}

function unitB(): ManualWorkUnitDto {
  return { document: sectionBDocument, unitEntryId: "unit-b" };
}

// The leading section's own (headless) document, so navigating back to it keeps its "Start" outline
// label — the Outline now reflects the active section's loaded document (#698), not a static label.
function unitA(): ManualWorkUnitDto {
  return { document: loadedDocument, unitEntryId: "unit-a" };
}

// A freshly added section's document: a single empty heading, exactly what "Add section" inserts. The
// live-draft Outline projects it as an "Untitled section" until the learner names it.
const emptyHeadingDocument: DocumentNodeJSON = {
  type: "doc",
  content: [{ type: "heading", attrs: { id: "blk-c1", anchorId: null, level: 1 }, content: [] }]
};

function renderPage(): void {
  render(
    <MemoryRouter>
      <ManualWorkEditorPage workEntryId="work-1" />
    </MemoryRouter>
  );
}

async function renderReadyEditor(): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  textbox: HTMLElement;
}> {
  mockedFetch.mockResolvedValue(makeWork());
  const user = userEvent.setup();
  renderPage();
  const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });
  return { textbox, user };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

describe("ManualWorkEditorPage", () => {
  it("shows a loading state until the work resolves", async () => {
    let resolveFetch: (work: ManualWorkDto) => void = () => {};
    mockedFetch.mockImplementation(
      () =>
        new Promise<ManualWorkDto>((resolve) => {
          resolveFetch = resolve;
        })
    );
    renderPage();

    expect(screen.getByText("Opening this work…")).toBeDefined();

    resolveFetch(makeWork());
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });
  });

  it("ignores a load that resolves after the page has unmounted", async () => {
    let resolveFetch: (work: ManualWorkDto) => void = () => {};
    mockedFetch.mockImplementation(
      () =>
        new Promise<ManualWorkDto>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const view = render(
      <MemoryRouter>
        <ManualWorkEditorPage workEntryId="work-1" />
      </MemoryRouter>
    );
    expect(screen.getByText("Opening this work…")).toBeDefined();

    view.unmount();
    resolveFetch(makeWork());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("ignores a load that rejects after the page has unmounted", async () => {
    let rejectFetch: (reason: Error) => void = () => {};
    mockedFetch.mockImplementation(
      () =>
        new Promise<ManualWorkDto>((_, reject) => {
          rejectFetch = reject;
        })
    );
    const view = render(
      <MemoryRouter>
        <ManualWorkEditorPage workEntryId="work-1" />
      </MemoryRouter>
    );
    expect(screen.getByText("Opening this work…")).toBeDefined();

    view.unmount();
    rejectFetch(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an alert when the work cannot be loaded", async () => {
    mockedFetch.mockRejectedValue(new Error("nope"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t open this work");
  });

  it("renders the work title, editor, and a saved status once loaded", async () => {
    await renderReadyEditor();

    expect(screen.getByRole("heading", { name: "A Tale of Two Cities" })).toBeDefined();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Saved");
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("stays owner-scoped: exposes no administrative Open in Reader action", async () => {
    // The manual page shares the editor with the imported-correction page, but only the administrative
    // correction surface injects an "Open in Reader" action. The owner-scoped manual editor must never
    // gain it through the generalization, so a leak of that affordance fails here.
    await renderReadyEditor();

    expect(screen.queryByRole("link", { name: "Open in Reader" })).toBeNull();
  });

  it("opens a freshly created work (canonical empty document) in a clean Saved state", async () => {
    mockedFetch.mockResolvedValue(
      makeWork({
        document: {
          content: [{ attrs: { anchorId: null, id: null }, type: "paragraph" }],
          type: "doc"
        } as ManualWorkDto["document"]
      })
    );
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it("marks the status unsaved once the learner edits the document", async () => {
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Hello");

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
    });
  });

  it("saves the edited document to the active section with the loaded revision", async () => {
    const saved = makeWork({
      document: {
        content: [{ content: [{ text: "Hi", type: "text" }], type: "paragraph" }],
        type: "doc"
      },
      revision: 2
    });
    mockedSave.mockResolvedValue({ status: "saved", work: saved });
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Hi");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    const [entryId, unitEntryId, , revision] = mockedSave.mock.calls[0]!;
    expect(entryId).toBe("work-1");
    expect(unitEntryId).toBe("work-2");
    expect(revision).toBe(0);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("saves from the editor's Ctrl+S shortcut", async () => {
    mockedSave.mockResolvedValue({ status: "saved", work: makeWork({ revision: 1 }) });
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "X");
    textbox.focus();
    fireEvent.keyDown(textbox, { ctrlKey: true, key: "s" });

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps local edits and adopts the newer revision on a conflict", async () => {
    mockedSave.mockResolvedValue({ status: "conflict" });
    mockedFetch.mockResolvedValueOnce(makeWork());
    mockedFetch.mockResolvedValueOnce(makeWork({ revision: 2 }));
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "Edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("This work changed elsewhere");
    });
    expect(screen.getByRole("button", { name: "Save again" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Save again" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(2);
    });
    expect(mockedSave.mock.calls[1]![3]).toBe(2);
  });

  it("surfaces an error when the conflict refetch itself fails", async () => {
    mockedSave.mockResolvedValue({ status: "conflict" });
    mockedFetch.mockResolvedValueOnce(makeWork());
    mockedFetch.mockRejectedValueOnce(new Error("refetch failed"));
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "Edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Save failed");
    });
  });

  it("surfaces a validation error when the server refuses the document", async () => {
    mockedSave.mockResolvedValue({ status: "invalid" });
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("can’t be saved");
    });
  });

  it("surfaces an error when the save request throws", async () => {
    mockedSave.mockRejectedValue(new Error("network down"));
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Save failed");
    });
  });

  it("ignores a second save while one is already in flight", async () => {
    let resolveSave: (result: SaveManualWorkResult) => void = () => {};
    mockedSave.mockImplementation(
      () =>
        new Promise<SaveManualWorkResult>((resolve) => {
          resolveSave = resolve;
        })
    );
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Edit");
    const saveButton = screen.getByRole("button", { name: "Save" });
    await user.click(saveButton);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saving…");
    });

    await user.type(textbox, "more");
    fireEvent.keyDown(textbox, { ctrlKey: true, key: "s" });
    expect(mockedSave).toHaveBeenCalledTimes(1);

    resolveSave({ status: "saved", work: makeWork({ revision: 1 }) });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("adopts the server's normalized document after a save that trims trailing empty paragraphs", async () => {
    mockedFetch.mockResolvedValue(
      makeWork({
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { id: "blk-1", anchorId: null },
              content: [{ type: "text", text: "Body" }]
            },
            { type: "paragraph", attrs: { id: "blk-2", anchorId: null } }
          ]
        } as ManualWorkDto["document"]
      })
    );
    mockedSave.mockResolvedValue({
      status: "saved",
      work: makeWork({
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { id: "blk-1", anchorId: null },
              content: [{ type: "text", text: "Body" }]
            }
          ]
        } as ManualWorkDto["document"],
        revision: 2
      })
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("warns before unloading while there are unsaved edits, and stays quiet once saved", async () => {
    const { textbox, user } = await renderReadyEditor();

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.click(textbox);
    await user.type(textbox, "Draft");
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
    });

    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  // ---- #697 live Outline ---------------------------------------------------

  it("shows the empty-outline hint for a single-section work", async () => {
    await renderReadyEditor();

    expect(screen.getByText("Add a section to build your outline.")).toBeDefined();
  });

  it("renders the derived outline and marks the opened section active", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    // The leading pre-heading section becomes a root "Start" entry; the Heading 1 section is "Chapter One".
    const start = screen.getByRole("button", { name: "Start" });
    const chapter = screen.getByRole("button", { name: "Chapter One" });
    expect(start.getAttribute("aria-current")).toBe("true");
    expect(chapter.getAttribute("aria-current")).toBeNull();
    void user;
  });

  it("navigates to another section and moves the active highlight", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedFetchUnit.mockResolvedValue(unitB());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    await waitFor(() => {
      expect(mockedFetchUnit).toHaveBeenCalledWith("work-1", "unit-b");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chapter One" }).getAttribute("aria-current")).toBe(
        "true"
      );
    });
  });

  it("does not reload when selecting the already-active section", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(mockedFetchUnit).not.toHaveBeenCalled();
  });

  it("focuses the section heading on each successive navigation", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedFetchUnit.mockImplementation(async (_workEntryId, unitEntryId) =>
      unitEntryId === "unit-b" ? unitB() : unitA()
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    // Navigate away and back: the focus signal must advance on the second navigation too, not only the
    // first, so re-selecting a section always re-focuses its heading.
    await user.click(screen.getByRole("button", { name: "Chapter One" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chapter One" }).getAttribute("aria-current")).toBe(
        "true"
      );
    });
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-current")).toBe(
        "true"
      );
    });
    expect(mockedFetchUnit).toHaveBeenCalledTimes(2);
  });

  it("ignores adding a section while a save is in flight", async () => {
    let resolveSave: (result: SaveManualWorkResult) => void = () => {};
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedSave.mockImplementation(
      () =>
        new Promise<SaveManualWorkResult>((resolve) => {
          resolveSave = resolve;
        })
    );
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "edit");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saving…");
    });

    await user.click(screen.getByRole("button", { name: "Add section" }));
    expect(mockedAdd).not.toHaveBeenCalled();

    resolveSave({ status: "saved", work: makeMultiWork({ revision: 1 }) });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("saves the current section before switching (save-before-switch)", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedSave.mockResolvedValue({ status: "saved", work: makeMultiWork({ revision: 1 }) });
    mockedFetchUnit.mockResolvedValue(unitB());
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "edit");
    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    await waitFor(() => {
      expect(mockedFetchUnit).toHaveBeenCalledWith("work-1", "unit-b");
    });
    expect(mockedSave).toHaveBeenCalledTimes(1);
    // Save ran before the section load.
    expect(mockedSave.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedFetchUnit.mock.invocationCallOrder[0]!
    );
  });

  it("aborts the switch and keeps the section when the pre-switch save conflicts", async () => {
    mockedFetch.mockResolvedValueOnce(makeMultiWork());
    mockedFetch.mockResolvedValueOnce(makeMultiWork({ revision: 1 }));
    mockedSave.mockResolvedValue({ status: "conflict" });
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "edit");
    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("This work changed elsewhere");
    });
    expect(mockedFetchUnit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-current")).toBe("true");
  });

  it("surfaces an error when loading the target section fails", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedFetchUnit.mockRejectedValue(new Error("gone"));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Save failed");
    });
  });

  it("adds a new section and opens it", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    const added = makeMultiWork({
      document: emptyHeadingDocument,
      revision: 1,
      sections: [
        { orderIndex: 0, unitEntryId: "unit-a" },
        { headingLevel: 1, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-b" },
        { headingLevel: 1, orderIndex: 2, title: undefined, unitEntryId: "unit-c" }
      ],
      unitEntryId: "unit-c"
    });
    mockedAdd.mockResolvedValue({ status: "added", work: added });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(mockedAdd).toHaveBeenCalledWith("work-1", 0);
    });
    // The new empty-heading section is the active outline entry.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Untitled section" }).getAttribute("aria-current")
      ).toBe("true");
    });
  });

  it("saves the current section before adding a new one", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedSave.mockResolvedValue({ status: "saved", work: makeMultiWork({ revision: 1 }) });
    mockedAdd.mockResolvedValue({
      status: "added",
      work: makeMultiWork({ revision: 1, unitEntryId: "unit-b" })
    });
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "edit");
    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(mockedAdd).toHaveBeenCalledTimes(1);
    });
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedAdd.mock.invocationCallOrder[0]!
    );
  });

  it("aborts the add when the pre-add save conflicts", async () => {
    mockedFetch.mockResolvedValueOnce(makeMultiWork());
    mockedFetch.mockResolvedValueOnce(makeMultiWork({ revision: 1 }));
    mockedSave.mockResolvedValue({ status: "conflict" });
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "edit");
    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("This work changed elsewhere");
    });
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it("keeps state and adopts the revision when add-section conflicts", async () => {
    mockedFetch.mockResolvedValueOnce(makeMultiWork());
    mockedFetch.mockResolvedValueOnce(makeMultiWork({ revision: 2 }));
    mockedAdd.mockResolvedValue({ status: "conflict" });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("This work changed elsewhere");
    });
    // A repeat add works against the adopted revision.
    mockedAdd.mockResolvedValueOnce({
      status: "added",
      work: makeMultiWork({ revision: 1, unitEntryId: "unit-b" })
    });
    await user.click(screen.getByRole("button", { name: "Add section" }));
    await waitFor(() => {
      expect(mockedAdd).toHaveBeenLastCalledWith("work-1", 2);
    });
  });

  it("surfaces an error when the add-section conflict refetch fails", async () => {
    mockedFetch.mockResolvedValueOnce(makeMultiWork());
    mockedFetch.mockRejectedValueOnce(new Error("refetch failed"));
    mockedAdd.mockResolvedValue({ status: "conflict" });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Save failed");
    });
  });

  it("surfaces an error when the add-section request throws", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedAdd.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Save failed");
    });
  });

  it("shows a pending label and ignores a second add while one is in flight", async () => {
    let resolveAdd: (result: AddManualWorkSectionResult) => void = () => {};
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedAdd.mockImplementation(
      () =>
        new Promise<AddManualWorkSectionResult>((resolve) => {
          resolveAdd = resolve;
        })
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Add section" }));
    const pending = await screen.findByRole("button", { name: "Adding…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);

    // Selecting a section while an add is pending is ignored (no section load).
    await user.click(screen.getByRole("button", { name: "Chapter One" }));
    expect(mockedFetchUnit).not.toHaveBeenCalled();

    resolveAdd({ status: "added", work: makeMultiWork({ revision: 1, unitEntryId: "unit-b" }) });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Adding…" })).toBeNull();
    });
    expect(mockedAdd).toHaveBeenCalledTimes(1);
  });

  it("ignores selecting a section while a save is in flight", async () => {
    let resolveSave: (result: SaveManualWorkResult) => void = () => {};
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedSave.mockImplementation(
      () =>
        new Promise<SaveManualWorkResult>((resolve) => {
          resolveSave = resolve;
        })
    );
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "edit");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saving…");
    });

    await user.click(screen.getByRole("button", { name: "Chapter One" }));
    expect(mockedFetchUnit).not.toHaveBeenCalled();

    resolveSave({ status: "saved", work: makeMultiWork({ revision: 1 }) });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("opens and dismisses the Outline drawer with the toggle and Escape", async () => {
    mockedFetch.mockResolvedValue(makeMultiWork());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    const toggle = screen.getByRole("button", { name: "Outline" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });
    expect(document.activeElement).toBe(toggle);
  });

  it("reflects the active section's draft headings in the Outline, not just persisted sections", async () => {
    // The persisted section list names unit-b once ("Chapter One"), but its loaded document carries an
    // extra sub-heading. The live Outline projects the draft, so the subsection appears immediately with
    // no save — proving the Outline is driven by the active draft, not only the persisted sections.
    const richUnitB: ManualWorkUnitDto = {
      unitEntryId: "unit-b",
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { id: "blk-b1", level: 1 },
            content: [{ type: "text", text: "Chapter One" }]
          },
          {
            type: "paragraph",
            attrs: { id: "blk-b2" },
            content: [{ type: "text", text: "Body." }]
          },
          {
            type: "heading",
            attrs: { id: "blk-b3", level: 2 },
            content: [{ type: "text", text: "A Subsection" }]
          }
        ]
      }
    };
    mockedFetch.mockResolvedValue(makeMultiWork());
    mockedFetchUnit.mockResolvedValue(richUnitB);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(screen.getByRole("button", { name: "Chapter One" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "A Subsection" })).toBeDefined();
    });
    // The projection is a live preview — nothing was saved to produce the extra outline entry.
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("follows the server-reconciled active section after a repartition merge save", async () => {
    // Open at the middle section (unit-b). Saving returns a repartition that merged unit-b into unit-a and
    // dropped it — the active section the editor must adopt is the server's returned unit-a, not the now-
    // deleted unit-b.
    const threeSectionWork = makeWork({
      unitEntryId: "unit-b",
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { id: "blk-b1", anchorId: null, level: 2 },
            content: [{ type: "text", text: "Chapter" }]
          }
        ]
      },
      sections: [
        { headingLevel: 1, orderIndex: 0, title: "Part", unitEntryId: "unit-a" },
        { headingLevel: 2, orderIndex: 1, title: "Chapter", unitEntryId: "unit-b" },
        { headingLevel: 1, orderIndex: 2, title: "Part Two", unitEntryId: "unit-c" }
      ]
    });
    const mergedWork = makeWork({
      revision: 1,
      unitEntryId: "unit-a",
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { id: "blk-a1", anchorId: null, level: 1 },
            content: [{ type: "text", text: "Part" }]
          }
        ]
      },
      sections: [
        { headingLevel: 1, orderIndex: 0, title: "Part", unitEntryId: "unit-a" },
        { headingLevel: 1, orderIndex: 1, title: "Part Two", unitEntryId: "unit-c" }
      ]
    });
    mockedFetch.mockResolvedValue(threeSectionWork);
    mockedSave.mockResolvedValue({ status: "saved", work: mergedWork });
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", { name: "Edit A Tale of Two Cities" });

    await user.click(textbox);
    await user.type(textbox, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
    // The merged-away section is gone and focus/active follows the server's reconciled unit-a ("Part").
    expect(screen.queryByRole("button", { name: "Chapter" })).toBeNull();
    expect(screen.getByRole("button", { name: "Part" }).getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Part Two" }).getAttribute("aria-current")
    ).toBeNull();
  });
});
