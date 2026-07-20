// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReactRouterDom from "react-router-dom";

vi.mock("./notesApi", () => ({
  fetchAllNotes: vi.fn()
}));

// A fixed learner zone so the notes list's review summaries are deterministic (#676).
vi.mock("../../shared/preferences/useLearnerTimeZone", () => ({
  useLearnerTimeZone: () => "UTC"
}));

// The workspace has its own suite; here it stands in as a controllable stub so the page's orchestration
// (opening, reloading on save/delete/review, focus return) is asserted without driving the real sheet.
vi.mock("./NoteWorkspace", async () => {
  const React = await import("react");
  return {
    NoteWorkspace: (props: {
      onClose: () => void;
      onDeleted: (id: string) => void;
      onReviewChanged: () => void;
      onSaved: () => void;
      target: { kind: string; note?: { entryId: string } };
    }) =>
      React.createElement("div", { "data-testid": "editor", "data-kind": props.target.kind }, [
        React.createElement(
          "button",
          { key: "s", onClick: () => props.onSaved(), type: "button" },
          "stub-save"
        ),
        React.createElement(
          "button",
          {
            key: "d",
            onClick: () => props.onDeleted(props.target.note?.entryId ?? ""),
            type: "button"
          },
          "stub-delete"
        ),
        React.createElement(
          "button",
          { key: "r", onClick: () => props.onReviewChanged(), type: "button" },
          "stub-review"
        ),
        React.createElement(
          "button",
          { key: "c", onClick: () => props.onClose(), type: "button" },
          "stub-close"
        )
      ])
  };
});

// The import surface has its own suite; here it stands in as a controllable stub so the page's
// orchestration (opening, closing, success message, reload, focus) is asserted without driving the panel.
vi.mock("./NotesImport", async () => {
  const React = await import("react");
  return {
    NotesImport: (props: {
      onCancel: () => void;
      onImported: (result: {
        imported: ReadonlyArray<{ noteEntryId: string; promptId: string }>;
      }) => void;
    }) =>
      React.createElement("div", { "data-testid": "import-panel" }, [
        React.createElement(
          "button",
          {
            key: "i2",
            onClick: () =>
              props.onImported({
                imported: [
                  { noteEntryId: "note-2", promptId: "prompt-2" },
                  { noteEntryId: "note-3", promptId: "prompt-3" }
                ]
              }),
            type: "button"
          },
          "stub-import-two"
        ),
        React.createElement(
          "button",
          {
            key: "i1",
            onClick: () =>
              props.onImported({ imported: [{ noteEntryId: "note-2", promptId: "prompt-2" }] }),
            type: "button"
          },
          "stub-import-one"
        ),
        React.createElement(
          "button",
          {
            key: "i0",
            onClick: () => props.onImported({ imported: [] }),
            type: "button"
          },
          "stub-import-none"
        ),
        React.createElement(
          "button",
          { key: "c", onClick: () => props.onCancel(), type: "button" },
          "stub-import-cancel"
        )
      ])
  };
});

// NotesPage now navigates to reveal a filtered-out new card; a hoisted stub captures the target without a
// Router in the test tree.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouterDom>();
  return { ...actual, useNavigate: () => navigateMock };
});

// The direct-card composer has its own suite; here it stands in as a controllable stub so the page's
// orchestration (opening, the created-card message, reload, focus / View card) is asserted in isolation.
vi.mock("./DirectCardComposer", async () => {
  const React = await import("react");
  return {
    DirectCardComposer: (props: {
      onClose: () => void;
      onCreated: (result: { noteId: string; promptId: string; review: unknown }) => void;
    }) =>
      React.createElement("div", { "data-testid": "composer" }, [
        React.createElement(
          "button",
          {
            key: "cr",
            onClick: () => props.onCreated({ noteId: "note-9", promptId: "prompt-9", review: {} }),
            type: "button"
          },
          "stub-create"
        ),
        React.createElement(
          "button",
          { key: "cl", onClick: () => props.onClose(), type: "button" },
          "stub-composer-close"
        )
      ])
  };
});

import type { NoteOverviewDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { fetchAllNotes } from "./notesApi";
import { NotesPage } from "./NotesPage";

const mockedFetch = vi.mocked(fetchAllNotes);

// Import is a secondary action in the page body (#641): its button opens the import panel directly.
async function openImportPanel(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
}

function note(entryId: string, body: string): NoteOverviewDto {
  return {
    anchor: null,
    authorName: null,
    blockEntryId: null,
    bodyDoc: createTextDocument(body),
    bodyText: body,
    captureSource: "manual",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId(entryId),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    review: { status: "not_enrolled" },
    updatedAt: "2024-01-01T00:00:00.000Z",
    workEntryId: null,
    workTitle: null
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("NotesPage (#659)", () => {
  it("loads the notes into one continuous list with a New card action and a search box", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first"), note("note-2", "second")] });

    render(<NotesPage />);

    expect(await screen.findByText("first")).toBeDefined();
    expect(screen.getByText("second")).toBeDefined();
    expect(screen.getByRole("button", { name: "New card" })).toBeDefined();
    expect(screen.getByRole("searchbox", { name: "Search notes" })).toBeDefined();
    expect(mockedFetch).toHaveBeenCalledWith({ search: undefined, workEntryId: undefined });
  });

  it("shows an empty state when the learner has no notes", async () => {
    mockedFetch.mockResolvedValue({ notes: [] });

    render(<NotesPage />);

    expect(
      await screen.findByText(/Notes appear from Reader capture, a new card, or Import/)
    ).toBeDefined();
  });

  it("shows a no-match state when a search returns nothing, then restores on clear", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "zzz");

    expect(await screen.findByText("No notes match “zzz”.")).toBeDefined();
    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith({ search: "zzz", workEntryId: undefined })
    );
  });

  it("shows an error state when the notes cannot be loaded", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));

    render(<NotesPage />);

    expect(await screen.findByText("Could not load your notes. Please try again.")).toBeDefined();
  });

  it("narrows to a single work and tells the fetch to filter", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first")] });

    render(<NotesPage focusWorkEntryId="work-a" />);

    await screen.findByText("first");
    expect(screen.getByText("Every note you have saved in this work.")).toBeDefined();
    expect(mockedFetch).toHaveBeenCalledWith({ search: undefined, workEntryId: "work-a" });
  });

  it("shows a work-scoped empty state when the focused work has no notes", async () => {
    mockedFetch.mockResolvedValue({ notes: [] });

    render(<NotesPage focusWorkEntryId="work-a" />);

    expect(await screen.findByText(/No notes yet for this work/)).toBeDefined();
  });

  it("opens the card composer, and on creation announces the card and focuses its new row", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [note("note-9", "ninth"), note("note-1", "first")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: "New card" }));
    expect(screen.getByTestId("composer")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "stub-create" }));

    expect(screen.queryByTestId("composer")).toBeNull();
    expect(await screen.findByText("Card created. Due now.")).toBeDefined();
    await screen.findByText("ninth");
    // The new card's note is in the list, so focus lands on its row and no "View card" is offered.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/ninth/)
    );
    expect(screen.queryByRole("button", { name: "View card" })).toBeNull();
  });

  it("offers View card when a filter hides the new card's note, and reveals it on click", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first")] });

    render(<NotesPage focusWorkEntryId="work-a" />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: "New card" }));
    await userEvent.click(screen.getByRole("button", { name: "stub-create" }));

    // The new standalone note is excluded by the work filter, so a "View card" affordance appears.
    expect(await screen.findByText("Card created. Due now.")).toBeDefined();
    const viewCard = await screen.findByRole("button", { name: "View card" });

    await userEvent.click(viewCard);
    expect(navigateMock).toHaveBeenCalledWith("/notes");
    expect(screen.queryByRole("button", { name: "View card" })).toBeNull();
  });

  it("closes the card composer without a message when cancelled", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: "New card" }));
    await userEvent.click(screen.getByRole("button", { name: "stub-composer-close" }));

    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByText("Card created. Due now.")).toBeNull();
  });

  it("opens the edit editor for a row and closes it on cancel", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: /Open note/ }));
    const editor = screen.getByTestId("editor");
    expect(editor.getAttribute("data-kind")).toBe("edit");

    await userEvent.click(within(editor).getByRole("button", { name: "stub-close" }));
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("keeps the editor open and reloads the list after a note is saved", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "edited")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: /Open note/ }));
    await userEvent.click(screen.getByRole("button", { name: "stub-save" }));

    // The workspace owns the create->edit transition and its Cards tab, so it stays open after a save;
    // Notes-home only refreshes the list behind it.
    expect(await screen.findByText("edited")).toBeDefined();
    expect(screen.getByTestId("editor")).toBeDefined();
  });

  it("reloads the list after a note is deleted", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: /Open note/ }));
    await userEvent.click(screen.getByRole("button", { name: "stub-delete" }));

    expect(
      await screen.findByText(/Notes appear from Reader capture, a new card, or Import/)
    ).toBeDefined();
  });

  it("refreshes the list when a note's review state changes, keeping the editor open", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first"), note("note-2", "second")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: /Open note/ }));
    await userEvent.click(screen.getByRole("button", { name: "stub-review" }));

    // The list reloads underneath while the editor stays open.
    await screen.findByText("second");
    expect(screen.getByTestId("editor")).toBeDefined();
  });

  it("discards a stale in-flight load that resolves after the query already moved on", async () => {
    let resolveStale: (value: { notes: ReadonlyArray<NoteOverviewDto> }) => void = () => {};
    const stale = new Promise<{ notes: ReadonlyArray<NoteOverviewDto> }>((resolve) => {
      resolveStale = resolve;
    });
    mockedFetch.mockReturnValueOnce(stale);
    mockedFetch.mockResolvedValue({ notes: [note("note-2", "fresh")] });

    render(<NotesPage />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "fresh");
    await screen.findByText("fresh");

    // The first load only now resolves; its result belongs to a superseded query and must be ignored.
    resolveStale({ notes: [note("note-1", "stale")] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("fresh")).toBeDefined();
  });

  it("discards a stale in-flight load that rejects after the query already moved on", async () => {
    let rejectStale: (reason: Error) => void = () => {};
    const stale = new Promise<{ notes: ReadonlyArray<NoteOverviewDto> }>((_resolve, reject) => {
      rejectStale = reject;
    });
    mockedFetch.mockReturnValueOnce(stale);
    mockedFetch.mockResolvedValue({ notes: [note("note-2", "fresh")] });

    render(<NotesPage />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes" }), "fresh");
    await screen.findByText("fresh");

    // A superseded load failing must not flip the settled list into the error state.
    rejectStale(new Error("stale boom"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Could not load your notes. Please try again.")).toBeNull();
    expect(screen.getByText("fresh")).toBeDefined();
  });
});

describe("NotesPage import (#661)", () => {
  it("opens the import panel, replacing the list and search until it closes", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await openImportPanel();
    expect(screen.getByTestId("import-panel")).toBeDefined();
    // The list and search box give way to the panel while importing.
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search notes" })).toBeNull();

    // Cancel restores the list and returns focus to the Import button (remounted with the list).
    await userEvent.click(screen.getByRole("button", { name: "stub-import-cancel" }));
    expect(screen.queryByTestId("import-panel")).toBeNull();
    expect(await screen.findByText("first")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Import" }));
  });

  it("reports how many notes were imported, reloads, and focuses the first imported note", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({
      notes: [note("note-1", "first"), note("note-2", "second"), note("note-3", "third")]
    });

    render(<NotesPage />);
    await screen.findByText("first");

    await openImportPanel();
    await userEvent.click(screen.getByRole("button", { name: "stub-import-two" }));

    // The panel closes, the success message shows the count, and the reloaded list appears.
    expect(screen.queryByTestId("import-panel")).toBeNull();
    expect(await screen.findByText("Imported 2 notes.")).toBeDefined();
    await screen.findByText("second");
    // Focus lands on the first imported note's Open button once the reloaded list settles.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/second/)
    );
  });

  it("uses the singular message when exactly one note is imported", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first"), note("note-2", "second")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await openImportPanel();
    await userEvent.click(screen.getByRole("button", { name: "stub-import-one" }));

    expect(await screen.findByText("Imported 1 note.")).toBeDefined();
  });

  it("closes the panel and reloads even if the import somehow yields no notes", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first")] });

    render(<NotesPage />);
    await screen.findByText("first");

    await openImportPanel();
    await userEvent.click(screen.getByRole("button", { name: "stub-import-none" }));

    expect(screen.queryByTestId("import-panel")).toBeNull();
    expect(await screen.findByText("Imported 0 notes.")).toBeDefined();
    expect(await screen.findByText("first")).toBeDefined();
  });
});
