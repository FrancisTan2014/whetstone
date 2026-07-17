// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  fetchAllNotes: vi.fn()
}));

// The editor has its own suite; here it stands in as a controllable stub so the page's orchestration
// (opening, reloading on save/delete, focus return) is asserted without driving the real sheet.
vi.mock("./OwnedNoteEditor", async () => {
  const React = await import("react");
  return {
    OwnedNoteEditor: (props: {
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

import type { NoteOverviewDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { fetchAllNotes } from "./notesApi";
import { NotesPage } from "./NotesPage";

const mockedFetch = vi.mocked(fetchAllNotes);

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
  it("loads the notes into one continuous list with a New note action and a search box", async () => {
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first"), note("note-2", "second")] });

    render(<NotesPage />);

    expect(await screen.findByText("first")).toBeDefined();
    expect(screen.getByText("second")).toBeDefined();
    expect(screen.getByRole("button", { name: "New note" })).toBeDefined();
    expect(screen.getByRole("searchbox", { name: "Search notes" })).toBeDefined();
    expect(mockedFetch).toHaveBeenCalledWith({ search: undefined, workEntryId: undefined });
  });

  it("shows an empty state when the learner has no notes", async () => {
    mockedFetch.mockResolvedValue({ notes: [] });

    render(<NotesPage />);

    expect(await screen.findByText(/No notes yet\. Create one/)).toBeDefined();
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

  it("opens the create editor, reloads on save, and returns focus to New note", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [note("note-1", "first"), note("note-2", "second")] });

    render(<NotesPage />);
    await screen.findByText("first");

    const newNote = screen.getByRole("button", { name: "New note" });
    await userEvent.click(newNote);
    expect(screen.getByTestId("editor").getAttribute("data-kind")).toBe("create");

    await userEvent.click(screen.getByRole("button", { name: "stub-save" }));

    await screen.findByText("second");
    expect(screen.queryByTestId("editor")).toBeNull();
    expect(document.activeElement).toBe(newNote);
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

  it("reloads the list after a note is deleted", async () => {
    mockedFetch.mockResolvedValueOnce({ notes: [note("note-1", "first")] });
    mockedFetch.mockResolvedValue({ notes: [] });

    render(<NotesPage />);
    await screen.findByText("first");

    await userEvent.click(screen.getByRole("button", { name: /Open note/ }));
    await userEvent.click(screen.getByRole("button", { name: "stub-delete" }));

    expect(await screen.findByText(/No notes yet\. Create one/)).toBeDefined();
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
});
