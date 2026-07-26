// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportedWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { MemoryRouter } from "react-router-dom";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImportedWorkCorrectionPage } from "./ImportedWorkCorrectionPage";
import { extractionEvidenceCueClass } from "../../shared/editor/extractionEvidence.tokens";

// The page renders the real shared rich editor, which drives ProseMirror against the DOM; jsdom lacks the
// layout/pointer primitives ProseMirror probes, so stub the minimal surface the editor touches (mirrors the
// manual editor page test — the two pages share the same editor).
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

vi.mock("./importedWorkApi", () => ({
  addImportedWorkSection: vi.fn(),
  fetchImportedWork: vi.fn(),
  fetchImportedWorkUnit: vi.fn(),
  saveImportedWorkContent: vi.fn()
}));

vi.mock("./pdfExtractionEvidenceApi", () => ({
  fetchPdfExtractionEvidence: vi.fn()
}));

const {
  addImportedWorkSection,
  fetchImportedWork,
  fetchImportedWorkUnit,
  saveImportedWorkContent
} = await import("./importedWorkApi");
const { fetchPdfExtractionEvidence } = await import("./pdfExtractionEvidenceApi");
const mockedAdd = addImportedWorkSection as Mock<typeof addImportedWorkSection>;
const mockedFetch = fetchImportedWork as Mock<typeof fetchImportedWork>;
const mockedFetchUnit = fetchImportedWorkUnit as Mock<typeof fetchImportedWorkUnit>;
const mockedSave = saveImportedWorkContent as Mock<typeof saveImportedWorkContent>;
const mockedEvidence = fetchPdfExtractionEvidence as Mock<typeof fetchPdfExtractionEvidence>;

// A realistic loaded document: a block with a stable persisted id, matching what the server reassembles
// from stored blocks. The editor preserves these ids, so its mount-time normalization echo equals the
// loaded document and the page opens in a clean "Saved" state.
const loadedDocument: DocumentNodeJSON = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "blk-1", anchorId: null },
      content: [{ type: "text", text: "Imported" }]
    }
  ]
};

function makeWork(overrides: Partial<ImportedWorkDto> = {}): ImportedWorkDto {
  return {
    correctedAt: null,
    document: loadedDocument,
    entryId: "work-1",
    language: "en",
    revision: 0,
    sections: [{ orderIndex: 0, unitEntryId: "unit-1" }],
    title: "Politics and the English Language",
    unitEntryId: "unit-1",
    workType: "essay",
    ...overrides
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <ImportedWorkCorrectionPage workEntryId="work-1" />
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
  const textbox = await screen.findByRole("textbox", {
    name: "Edit Politics and the English Language"
  });
  return { textbox, user };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia(false);
  // Default: the Work carries no extraction evidence (a non-PDF import), so the editor shows no cue.
  mockedEvidence.mockResolvedValue(new Map());
});

afterEach(() => {
  cleanup();
});

describe("ImportedWorkCorrectionPage", () => {
  it("shows a loading state until the work resolves", async () => {
    let resolveFetch: (work: ImportedWorkDto) => void = () => {};
    mockedFetch.mockImplementation(
      () =>
        new Promise<ImportedWorkDto>((resolve) => {
          resolveFetch = resolve;
        })
    );
    renderPage();

    expect(screen.getByText("Opening this work…")).toBeDefined();

    resolveFetch(makeWork());
    await screen.findByRole("textbox", { name: "Edit Politics and the English Language" });
  });

  it("ignores a load that resolves after the page has unmounted", async () => {
    let resolveFetch: (work: ImportedWorkDto) => void = () => {};
    mockedFetch.mockImplementation(
      () =>
        new Promise<ImportedWorkDto>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const view = render(
      <MemoryRouter>
        <ImportedWorkCorrectionPage workEntryId="work-1" />
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
        new Promise<ImportedWorkDto>((_, reject) => {
          rejectFetch = reject;
        })
    );
    const view = render(
      <MemoryRouter>
        <ImportedWorkCorrectionPage workEntryId="work-1" />
      </MemoryRouter>
    );
    expect(screen.getByText("Opening this work…")).toBeDefined();

    view.unmount();
    rejectFetch(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a correction-specific alert when the work cannot be opened", async () => {
    mockedFetch.mockRejectedValue(new Error("nope"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t open this work for correction");
  });

  it("renders the title, editor, an Open in Reader link, and a saved status once loaded", async () => {
    await renderReadyEditor();

    expect(
      screen.getByRole("heading", { name: "Politics and the English Language" })
    ).toBeDefined();
    const reader = screen.getByRole("link", { name: "Open in Reader" });
    expect(reader.getAttribute("href")).toBe("#/reader?work=work-1");
    expect(screen.getByRole("status").textContent).toContain("Saved");
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("corrects a block and saves it to the section with the loaded revision", async () => {
    const corrected = makeWork({
      correctedAt: "2026-02-02T00:00:00.000Z",
      document: {
        content: [{ content: [{ text: "Fixed", type: "text" }], type: "paragraph" }],
        type: "doc"
      },
      revision: 1
    });
    mockedSave.mockResolvedValue({ status: "saved", work: corrected });
    const { textbox, user } = await renderReadyEditor();

    await user.click(textbox);
    await user.type(textbox, "Fixed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(1);
    });
    const [entryId, unitEntryId, savedDocument, revision] = mockedSave.mock.calls[0]!;
    expect(entryId).toBe("work-1");
    expect(unitEntryId).toBe("unit-1");
    expect(revision).toBe(0);
    // The corrected block text the administrator typed is what reaches the imported-correction endpoint.
    expect(JSON.stringify(savedDocument)).toContain("Fixed");
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("keeps the correction and adopts the newer revision on a conflict, then overwrites on retry", async () => {
    mockedSave.mockResolvedValue({ status: "conflict" });
    mockedFetch.mockResolvedValueOnce(makeWork());
    mockedFetch.mockResolvedValueOnce(makeWork({ revision: 4 }));
    const user = userEvent.setup();
    renderPage();
    const textbox = await screen.findByRole("textbox", {
      name: "Edit Politics and the English Language"
    });

    await user.click(textbox);
    await user.type(textbox, "Edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("This work changed elsewhere");
    });

    await user.click(screen.getByRole("button", { name: "Save again" }));
    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledTimes(2);
    });
    // The retry deliberately overwrites the newer stored version at the adopted revision.
    expect(mockedSave.mock.calls[1]![3]).toBe(4);
  });

  it("adds a new section through the imported endpoint and opens it", async () => {
    mockedAdd.mockResolvedValue({
      status: "added",
      work: makeWork({
        revision: 1,
        sections: [
          { orderIndex: 0, unitEntryId: "unit-1" },
          { headingLevel: 1, orderIndex: 1, title: "New section", unitEntryId: "unit-2" }
        ],
        unitEntryId: "unit-2"
      })
    });
    const { user } = await renderReadyEditor();

    await user.click(screen.getByRole("button", { name: "Add section" }));

    await waitFor(() => {
      expect(mockedAdd).toHaveBeenCalledTimes(1);
    });
    expect(mockedAdd.mock.calls[0]).toEqual(["work-1", 0]);
    expect(mockedFetchUnit).not.toHaveBeenCalled();
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

  it("cues a review-suggested block, then refetches evidence after a correcting save so the cue clears", async () => {
    const evidenceRow = {
      blockId: "blk-1",
      confidence: 0.4,
      corrected: false,
      label: "Section heading",
      ocrEngine: null,
      ocrLanguage: null,
      page: 2,
      reviewSuggested: true
    };
    mockedEvidence.mockResolvedValueOnce(new Map([["blk-1", evidenceRow]]));
    // The corrected block keeps its persisted id, and the post-save refetch reports it as corrected.
    mockedSave.mockResolvedValue({
      status: "saved",
      work: makeWork({
        correctedAt: "2026-02-02T00:00:00.000Z",
        document: {
          content: [
            {
              attrs: { anchorId: null, id: "blk-1" },
              content: [{ text: "Fixed", type: "text" }],
              type: "paragraph"
            }
          ],
          type: "doc"
        },
        revision: 1
      })
    });
    mockedEvidence.mockResolvedValueOnce(new Map([["blk-1", { ...evidenceRow, corrected: true }]]));

    const { textbox, user } = await renderReadyEditor();

    // The uncorrected suggested block is cued once its evidence resolves.
    await waitFor(() => {
      expect(textbox.querySelector(`.${extractionEvidenceCueClass}`)).not.toBeNull();
    });
    expect(mockedEvidence).toHaveBeenCalledTimes(1);
    expect(mockedEvidence.mock.calls[0]![0]).toBe("work-1");

    await user.click(textbox);
    await user.type(textbox, "Fixed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // A successful save refetches evidence; the block now reads corrected, so its cue is gone.
    await waitFor(() => {
      expect(mockedEvidence).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(textbox.querySelector(`.${extractionEvidenceCueClass}`)).toBeNull();
    });
  });

  it("opens cleanly when the evidence fetch fails (evidence falls back to none)", async () => {
    mockedEvidence.mockReset();
    mockedEvidence.mockRejectedValue(new Error("evidence unavailable"));

    const { textbox } = await renderReadyEditor();

    await waitFor(() => {
      expect(mockedEvidence).toHaveBeenCalled();
    });
    // A failed evidence fetch never blocks correction: the editor opens with no cue.
    expect(textbox.querySelector(`.${extractionEvidenceCueClass}`)).toBeNull();
  });
});
