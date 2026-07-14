// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./todayApi", () => ({
  fetchTodayBoard: vi.fn()
}));

vi.mock("../capture/CaptureCard", () => ({
  CaptureCard: () => <section aria-label="Capture today">capture</section>
}));

import type { TodayBoardDto, TodayRoutineDto } from "@whetstone/contracts";

import { TodayPage } from "./TodayPage";
import { fetchTodayBoard } from "./todayApi";

const mockedFetch = vi.mocked(fetchTodayBoard);

function makeBoard(overrides: Partial<TodayBoardDto> = {}): TodayBoardDto {
  return {
    clear: true,
    continueReading: { status: "empty" },
    continueWriting: { status: "empty" },
    date: "2026-07-01",
    dueNow: [],
    newPassage: { status: "unavailable" },
    routineFailures: [],
    ...overrides
  };
}

const memoryDue: TodayRoutineDto = {
  dueCount: 1,
  kind: "memory",
  nextDueAt: "2026-07-01T06:00:00.000Z",
  overdue: false,
  overdueCount: 0
};

const recitationOverdue: TodayRoutineDto = {
  dueCount: 2,
  kind: "recitation",
  nextDueAt: "2026-06-30T22:00:00.000Z",
  overdue: true,
  overdueCount: 2
};

function renderPage(): void {
  render(
    <MemoryRouter>
      <TodayPage />
    </MemoryRouter>
  );
}

function href(name: RegExp | string): string | null {
  return screen.getByRole("link", { name }).getAttribute("href");
}

beforeEach(() => {
  mockedFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("TodayPage", () => {
  it("shows a loading state while the board is in flight", () => {
    mockedFetch.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByText("Loading your day…")).toBeTruthy();
  });

  it("surfaces an offline error with a Retry that recomputes the board", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("offline"));
    renderPage();

    const retry = await screen.findByRole("button", { name: "Retry" });
    mockedFetch.mockResolvedValueOnce(makeBoard());
    await userEvent.click(retry);

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("shows the truthful clear line only when the board is clear and something can be continued", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({
        continueReading: {
          position: {
            anchorBlockEntryId: null,
            unitEntryId: "unit-1",
            workEntryId: "work-1",
            workTitle: "Fables"
          },
          status: "ready"
        }
      })
    );
    renderPage();

    expect(await screen.findByText("All due work is clear.")).toBeTruthy();
    expect(screen.queryByText(/Start with one source/)).toBeNull();
    expect(href(/Keep reading Fables/)).toBe("/reader?work=work-1");
    expect(href("Return to your diary")).toBe("/diary");
  });

  it("shows a first-run on-ramp instead of the clear line when there is nothing to continue", async () => {
    mockedFetch.mockResolvedValue(makeBoard());
    renderPage();

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(screen.queryByText("All due work is clear.")).toBeNull();
    expect(href("Go to your Library")).toBe("/library");
    // Continue empties render as quiet copy; the unavailable new passage offers no invitation.
    expect(screen.getByText("No reading in progress.")).toBeTruthy();
    expect(screen.getByText("No writing in progress.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Start a new passage" })).toBeNull();
  });

  it("groups a single due routine into one row with a review deep link", async () => {
    mockedFetch.mockResolvedValue(makeBoard({ clear: false, dueNow: [memoryDue] }));
    renderPage();

    expect(await screen.findByText("Memory review")).toBeTruthy();
    expect(screen.getByText("1 due")).toBeTruthy();
    expect(screen.queryByText(/overdue/)).toBeNull();
    expect(href("Review")).toBe("/recall");
    expect(screen.getByRole("listitem")).toBeTruthy();
    expect(screen.queryByText("All due work is clear.")).toBeNull();
    expect(screen.queryByText(/Start with one source/)).toBeNull();
  });

  it("orders overdue routines first and emphasizes the overdue count", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({ clear: false, dueNow: [recitationOverdue, memoryDue] })
    );
    renderPage();

    await screen.findByText("Recitation");
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("Recitation");
    expect(rows[0]?.textContent).toContain("2 due · 2 overdue");
    expect(rows[1]?.textContent).toContain("Memory review");
    expect(href("Start")).toBe("/recitation");
  });

  it("keeps the board un-clear and offers a Retry when a routine source fails", async () => {
    mockedFetch.mockResolvedValueOnce(makeBoard({ clear: false, routineFailures: ["memory"] }));
    renderPage();

    expect(await screen.findByText("Couldn’t load your memory review right now.")).toBeTruthy();
    expect(screen.queryByText("All due work is clear.")).toBeNull();

    mockedFetch.mockResolvedValueOnce(makeBoard());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(screen.queryByText("Couldn’t load your memory review right now.")).toBeNull();
  });

  it("offers each ready Continue invitation as a deep link into its feature", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({
        continueReading: {
          position: {
            anchorBlockEntryId: null,
            unitEntryId: "unit-1",
            workEntryId: "work-1",
            workTitle: "Fables"
          },
          status: "ready"
        },
        continueWriting: {
          work: {
            createdAt: "2026-06-01T00:00:00.000Z",
            entryId: "draft-1",
            language: "en",
            title: "My Draft",
            updatedAt: "2026-06-30T00:00:00.000Z",
            workType: "book"
          },
          status: "ready"
        },
        newPassage: { planEntryId: "plan-1", status: "available" }
      })
    );
    renderPage();

    expect(await screen.findByRole("link", { name: /Keep reading Fables/ })).toBeTruthy();
    expect(href(/Keep reading Fables/)).toBe("/reader?work=work-1");
    expect(href(/Keep writing My Draft/)).toBe("/write?work=draft-1");
    expect(href("Start a new passage")).toBe("/recitation");
  });

  it("surfaces a quiet Retry for every failed Continue invitation", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeBoard({
        continueReading: { status: "failed" },
        continueWriting: { status: "failed" },
        newPassage: { status: "failed" }
      })
    );
    renderPage();

    expect(await screen.findByText("Couldn’t load your reading right now.")).toBeTruthy();
    expect(screen.getByText("Couldn’t load your writing right now.")).toBeTruthy();
    expect(screen.getByText("Couldn’t load your new passage right now.")).toBeTruthy();

    mockedFetch.mockResolvedValueOnce(makeBoard());
    const [firstRetry] = screen.getAllByRole("button", { name: "Retry" });
    await userEvent.click(firstRetry!);
    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
  });

  it("recomputes the board when the tab regains focus", async () => {
    mockedFetch.mockResolvedValueOnce(makeBoard({ clear: false, dueNow: [memoryDue] }));
    renderPage();
    await screen.findByText("Memory review");

    mockedFetch.mockResolvedValueOnce(makeBoard());
    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(screen.queryByText("Memory review")).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the save-first quick capture present on every board", async () => {
    mockedFetch.mockResolvedValue(makeBoard({ clear: false, dueNow: [memoryDue] }));
    renderPage();

    expect(await screen.findByLabelText("Capture today")).toBeTruthy();
  });

  it("keeps the save-first quick capture present while the board is still loading", () => {
    mockedFetch.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByText("Loading your day…")).toBeTruthy();
    expect(screen.getByLabelText("Capture today")).toBeTruthy();
  });
});
