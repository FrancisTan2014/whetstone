// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memoryApi", () => ({
  listMemoryNotes: vi.fn()
}));

vi.mock("./MemoryQuickAdd", () => ({
  MemoryQuickAdd: ({ onCreated }: { onCreated: () => void }): React.JSX.Element => (
    <button onClick={onCreated} type="button">
      stub created
    </button>
  )
}));

vi.mock("./MemoryImport", () => ({
  MemoryImport: ({
    onCancel,
    onImported
  }: {
    onCancel: () => void;
    onImported: () => void;
  }): React.JSX.Element => (
    <div>
      <p>stub import</p>
      <button onClick={onCancel} type="button">
        stub import cancel
      </button>
      <button onClick={onImported} type="button">
        stub imported
      </button>
    </div>
  )
}));

vi.mock("./MemoryNoteDetail", () => ({
  MemoryNoteDetail: ({
    noteId,
    onClose
  }: {
    noteId: string;
    onClose: () => void;
  }): React.JSX.Element => (
    <div>
      <p>detail {noteId}</p>
      <button onClick={onClose} type="button">
        stub close
      </button>
    </div>
  )
}));

import type { MemoryNoteSummaryDto } from "@whetstone/contracts";

import { listMemoryNotes } from "./memoryApi";
import { MemoryPage } from "./MemoryPage";

const mockedList = vi.mocked(listMemoryNotes);

function makeSummary(overrides: Partial<MemoryNoteSummaryDto> = {}): MemoryNoteSummaryDto {
  return {
    bodyText: "spill the beans",
    captureSource: "manual",
    draftCount: 0,
    dueCount: 0,
    nextDueAt: null,
    noteId: "note-1",
    promptCount: 1,
    scheduledCount: 1,
    ...overrides
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <MemoryPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("MemoryPage", () => {
  it("always renders the Memory heading, including while loading", () => {
    mockedList.mockReturnValue(new Promise<ReadonlyArray<MemoryNoteSummaryDto>>(() => {}));
    renderPage();

    expect(screen.getByRole("heading", { name: "Memory" }).id).toBe("memory-heading");
    expect(screen.getByText(/Gathering your memory/)).toBeDefined();
  });

  it("shows an error state when the list cannot load", async () => {
    mockedList.mockRejectedValue(new Error("boom"));
    renderPage();

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not load your memory/);
  });

  it("links to the review flow when something is due", async () => {
    mockedList.mockResolvedValue([
      makeSummary({ dueCount: 2 }),
      makeSummary({ dueCount: 1, noteId: "note-2" })
    ]);
    renderPage();

    const link = await screen.findByRole("link", { name: "Review 3 due" });
    expect(link.getAttribute("href")).toBe("/recall");
    expect(screen.getByRole("search")).toBeDefined();
    expect(screen.getByRole("button", { name: "stub created" })).toBeDefined();
  });

  it("shows a calm nothing-due message and the empty-list message when there is nothing kept", async () => {
    mockedList.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("Nothing due right now.")).toBeDefined();
    expect(screen.getByText(/Nothing kept yet/)).toBeDefined();
    expect(screen.queryByRole("link", { name: /Review/ })).toBeNull();
  });

  it("searches on submit and shows a no-matches message for an empty result", async () => {
    mockedList.mockResolvedValueOnce([makeSummary()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("spill the beans");
    mockedList.mockResolvedValueOnce([]);
    await user.type(screen.getByLabelText("Search your memory"), "zzz{Enter}");

    await waitFor(() => expect(mockedList).toHaveBeenLastCalledWith("zzz"));
    expect(await screen.findByText("No matches.")).toBeDefined();
  });

  it("opens a note's detail on select and reloads the list on close", async () => {
    mockedList.mockResolvedValue([makeSummary({ bodyText: "pick me", noteId: "note-7" })]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText("pick me"));
    expect(screen.getByText("detail note-7")).toBeDefined();
    expect(screen.queryByRole("search")).toBeNull();

    await user.click(screen.getByRole("button", { name: "stub close" }));

    await screen.findByText("pick me");
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it("reloads the list after Quick Add reports a new memory", async () => {
    mockedList.mockResolvedValue([makeSummary()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "stub created" }));

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(mockedList).toHaveBeenLastCalledWith("");
  });

  it("renders the row inside the memory list landmark", async () => {
    mockedList.mockResolvedValue([makeSummary({ bodyText: "spill the beans" })]);
    renderPage();

    const list = await screen.findByRole("list", { name: "Your memory" });
    expect(within(list).getByText("spill the beans")).toBeDefined();
  });

  it("keeps the review link when a reload returns a different list with the same due total", async () => {
    mockedList.mockResolvedValueOnce([makeSummary({ dueCount: 2 })]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("link", { name: "Review 2 due" });
    // A search reload swaps in a different notes array that still totals two due: the banner
    // re-renders with a new reference but an unchanged count, exercising its memoized cache-hit.
    mockedList.mockResolvedValueOnce([makeSummary({ dueCount: 2, noteId: "note-2" })]);
    await user.type(screen.getByLabelText("Search your memory"), "x{Enter}");

    await waitFor(() => expect(mockedList).toHaveBeenLastCalledWith("x"));
    expect(await screen.findByRole("link", { name: "Review 2 due" })).toBeDefined();
  });

  it("toggles the paste-a-list importer and returns to the list on cancel", async () => {
    mockedList.mockResolvedValue([makeSummary()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Paste a list" }));

    expect(screen.getByText("stub import")).toBeDefined();
    // The quick-add and list are hidden while the importer is open.
    expect(screen.queryByRole("button", { name: "stub created" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "stub import cancel" }));

    expect(await screen.findByText("spill the beans")).toBeDefined();
    expect(screen.queryByText("stub import")).toBeNull();
  });

  it("returns to the list and reloads after the importer reports imported memories", async () => {
    mockedList.mockResolvedValue([makeSummary()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Paste a list" }));
    await user.click(screen.getByRole("button", { name: "stub imported" }));

    await screen.findByText("spill the beans");
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("stub import")).toBeNull();
  });
});
