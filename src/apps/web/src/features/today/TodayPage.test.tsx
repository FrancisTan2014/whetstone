// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./todayApi", () => ({
  fetchTodayBoard: vi.fn()
}));

vi.mock("./TodayCapture", () => ({
  TodayCapture: () => <section aria-label="New diary entry">capture</section>
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
    nextReviewAt: null,
    routineFailures: [],
    ...overrides
  };
}

const readingReady: TodayBoardDto["continueReading"] = {
  position: {
    anchorBlockEntryId: null,
    unitEntryId: "unit-1",
    workEntryId: "work-1",
    workTitle: "Fables"
  },
  status: "ready"
};

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

  it("shows the calm Done-for-today state when the board is clear and something can be continued", async () => {
    mockedFetch.mockResolvedValue(makeBoard({ continueReading: readingReady }));
    renderPage();

    expect(await screen.findByText("Done for today.")).toBeTruthy();
    expect(screen.queryByText(/Start with one source/)).toBeNull();
    expect(href(/Keep reading Fables/)).toBe("/reader?work=work-1");
    // The permanent diary-return link is gone now Diary is a primary destination (#638).
    expect(screen.queryByText("Return to your diary")).toBeNull();
  });

  it("reports the next known review date beneath Done for today when one exists", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({ continueReading: readingReady, nextReviewAt: "2026-07-20T00:00:00.000Z" })
    );
    renderPage();

    expect(await screen.findByText("Done for today.")).toBeTruthy();
    expect(screen.getByText("Next review July 20, 2026.")).toBeTruthy();
  });

  it("omits the next-review line when nothing is enrolled ahead", async () => {
    mockedFetch.mockResolvedValue(makeBoard({ continueReading: readingReady, nextReviewAt: null }));
    renderPage();

    expect(await screen.findByText("Done for today.")).toBeTruthy();
    expect(screen.queryByText(/Next review/)).toBeNull();
  });

  it("shows a first-run on-ramp with no empty Continue placeholders when there is nothing to continue", async () => {
    mockedFetch.mockResolvedValue(makeBoard());
    renderPage();

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(screen.queryByText("Done for today.")).toBeNull();
    expect(href("Go to your Library")).toBe("/library");
    // Empty continuations render nothing at all — no placeholder copy and no Continue heading.
    expect(screen.queryByText("No reading in progress.")).toBeNull();
    expect(screen.queryByText("No writing in progress.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Continue" })).toBeNull();
  });

  it("groups a single due Notes-review routine into one row with a Review deep link", async () => {
    mockedFetch.mockResolvedValue(makeBoard({ clear: false, dueNow: [memoryDue] }));
    renderPage();

    expect(await screen.findByText("Notes review")).toBeTruthy();
    expect(screen.getByText("1 due")).toBeTruthy();
    expect(screen.queryByText(/overdue/)).toBeNull();
    expect(href("Review")).toBe("/notes/review");
    expect(screen.getByRole("listitem")).toBeTruthy();
    expect(screen.queryByText("Done for today.")).toBeNull();
    expect(screen.queryByText(/Start with one source/)).toBeNull();
  });

  it("orders overdue routines first, emphasizes the overdue count, and opens each into Review", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({ clear: false, dueNow: [recitationOverdue, memoryDue] })
    );
    renderPage();

    await screen.findByText("Recitation");
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("Recitation");
    expect(rows[0]?.textContent).toContain("2 due · 2 overdue");
    expect(rows[1]?.textContent).toContain("Notes review");
    // Both required rows open a direct review, so both actions read "Review".
    expect(within(rows[0]!).getByRole("link", { name: "Review" }).getAttribute("href")).toBe(
      "/recitation"
    );
    expect(within(rows[1]!).getByRole("link", { name: "Review" }).getAttribute("href")).toBe(
      "/notes/review"
    );
  });

  it("keeps the board un-clear and offers a Retry when a routine source fails", async () => {
    mockedFetch.mockResolvedValueOnce(makeBoard({ clear: false, routineFailures: ["memory"] }));
    renderPage();

    expect(await screen.findByText("Couldn’t load your notes review right now.")).toBeTruthy();
    expect(screen.queryByText("Done for today.")).toBeNull();

    mockedFetch.mockResolvedValueOnce(makeBoard());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(screen.queryByText("Couldn’t load your notes review right now.")).toBeNull();
  });

  it("offers each ready Continue invitation as a deep link into its feature", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({
        continueReading: readingReady,
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
        }
      })
    );
    renderPage();

    expect(await screen.findByRole("link", { name: /Keep reading Fables/ })).toBeTruthy();
    expect(href(/Keep reading Fables/)).toBe("/reader?work=work-1");
    expect(href(/Keep writing My Draft/)).toBe("/write?work=draft-1");
  });

  it("renders the Continue section for writing alone when only reading is empty", async () => {
    mockedFetch.mockResolvedValue(
      makeBoard({
        continueReading: { status: "empty" },
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
        }
      })
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Keep writing My Draft/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Keep reading/ })).toBeNull();
  });

  it("surfaces a quiet Retry for every failed Continue invitation", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeBoard({
        continueReading: { status: "failed" },
        continueWriting: { status: "failed" }
      })
    );
    renderPage();

    expect(await screen.findByText("Couldn’t load your reading right now.")).toBeTruthy();
    expect(screen.getByText("Couldn’t load your writing right now.")).toBeTruthy();

    mockedFetch.mockResolvedValueOnce(makeBoard());
    const [firstRetry] = screen.getAllByRole("button", { name: "Retry" });
    await userEvent.click(firstRetry!);
    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
  });

  it("recomputes the board when the tab regains focus", async () => {
    mockedFetch.mockResolvedValueOnce(makeBoard({ clear: false, dueNow: [memoryDue] }));
    renderPage();
    await screen.findByText("Notes review");

    mockedFetch.mockResolvedValueOnce(makeBoard());
    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByText(/Start with one source/)).toBeTruthy();
    expect(screen.queryByText("Notes review")).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the compact capture present on every board", async () => {
    mockedFetch.mockResolvedValue(makeBoard({ clear: false, dueNow: [memoryDue] }));
    renderPage();

    expect(await screen.findByLabelText("New diary entry")).toBeTruthy();
  });

  it("keeps the compact capture present while the board is still loading", () => {
    mockedFetch.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByText("Loading your day…")).toBeTruthy();
    expect(screen.getByLabelText("New diary entry")).toBeTruthy();
  });
});
