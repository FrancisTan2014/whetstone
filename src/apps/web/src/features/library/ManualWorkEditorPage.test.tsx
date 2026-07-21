// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { MemoryRouter } from "react-router-dom";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaveManualWorkResult } from "./manualWorkApi";
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
  fetchManualWork: vi.fn(),
  saveManualWorkContent: vi.fn()
}));

const { fetchManualWork, saveManualWorkContent } = await import("./manualWorkApi");
const mockedFetch = fetchManualWork as Mock<typeof fetchManualWork>;
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

function makeWork(overrides: Partial<ManualWorkDto> = {}): ManualWorkDto {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    document: loadedDocument,
    entryId: "work-1",
    language: "en",
    revision: "2026-01-01T00:00:00.000Z",
    title: "A Tale of Two Cities",
    unitEntryId: "work-2",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workType: "book",
    ...overrides
  };
}

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

  it("opens a freshly created work (canonical empty document) in a clean Saved state", async () => {
    // A never-edited manual work loads the initializer's canonical empty paragraph, whose id is null.
    // The editor stamps a generated id on mount and echoes it; the page must recognise that id-only
    // difference as unchanged and read "Saved", not spuriously "Unsaved changes".
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
    // The unsaved guard must stay disarmed, so a reload/close does not warn before any edit.
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

  it("saves the edited document with the loaded revision and returns to saved", async () => {
    const saved = makeWork({
      document: {
        content: [{ content: [{ text: "Hi", type: "text" }], type: "paragraph" }],
        type: "doc"
      },
      revision: "2026-02-02T00:00:00.000Z"
    });
    mockedSave.mockResolvedValue({ status: "saved", work: saved });
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Hi");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    const [entryId, , revision] = mockedSave.mock.calls[0]!;
    expect(entryId).toBe("work-1");
    expect(revision).toBe("2026-01-01T00:00:00.000Z");
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("saves from the editor's Ctrl+S shortcut", async () => {
    mockedSave.mockResolvedValue({ status: "saved", work: makeWork({ revision: "r2" }) });
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
    mockedFetch.mockResolvedValueOnce(makeWork({ revision: "2026-03-03T00:00:00.000Z" }));
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
    expect(mockedSave.mock.calls[1]![2]).toBe("2026-03-03T00:00:00.000Z");
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

    // A change and a second save attempt while the first is pending must not launch a second write.
    await user.type(textbox, "more");
    fireEvent.keyDown(textbox, { ctrlKey: true, key: "s" });
    expect(mockedSave).toHaveBeenCalledTimes(1);

    resolveSave({ status: "saved", work: makeWork({ revision: "r2" }) });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
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
});
