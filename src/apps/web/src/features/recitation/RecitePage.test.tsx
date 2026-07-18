// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./reciteOverviewApi", () => ({
  fetchRecitationOverview: vi.fn()
}));

import { fetchRecitationOverview } from "./reciteOverviewApi";
import { RecitePage } from "./RecitePage";

const mockedFetch = vi.mocked(fetchRecitationOverview);

function renderPage(): void {
  render(
    <MemoryRouter>
      <RecitePage />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecitePage", () => {
  it("lists enrolled Works with their due state and next review date, leading with due review", async () => {
    mockedFetch.mockResolvedValue({
      dueCount: 1,
      works: [
        {
          isDue: true,
          nextReviewAt: "2026-07-01T09:00:00.000Z",
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "Ode to the West Wind"
        },
        {
          isDue: false,
          nextReviewAt: "2026-08-15T09:00:00.000Z",
          paused: false,
          planEntryId: "plan-2",
          state: "review",
          workEntryId: "work-2",
          workTitle: "Tang Poems"
        }
      ]
    });

    renderPage();

    // Leads with the due-review entry, opening the earliest-due Work's review.
    const startReview = await screen.findByRole("link", { name: "Start due review" });
    expect(startReview.getAttribute("href")).toBe("/recitation");
    expect(screen.getByText("1 Work is due for review.")).toBeDefined();

    const list = screen.getByRole("list", { name: "Enrolled Works" });
    const dueWork = within(list).getByRole("link", { name: /Ode to the West Wind/ });
    expect(dueWork.getAttribute("href")).toBe("/recitation?work=work-1");
    expect(within(dueWork).getByText("Due now")).toBeDefined();

    const scheduledWork = within(list).getByRole("link", { name: /Tang Poems/ });
    expect(scheduledWork.getAttribute("href")).toBe("/recitation?work=work-2");
    expect(within(scheduledWork).getByText(/Next review August 15, 2026/)).toBeDefined();
  });

  it("pluralizes the due-count lead when more than one Work is due", async () => {
    mockedFetch.mockResolvedValue({
      dueCount: 2,
      works: [
        {
          isDue: true,
          nextReviewAt: "2026-07-01T09:00:00.000Z",
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "Ode to the West Wind"
        },
        {
          isDue: true,
          nextReviewAt: "2026-07-01T09:00:00.000Z",
          paused: false,
          planEntryId: "plan-2",
          state: "review",
          workEntryId: "work-2",
          workTitle: "Tang Poems"
        }
      ]
    });

    renderPage();

    expect(await screen.findByText("2 Works are due for review.")).toBeDefined();
    expect(screen.queryByText("1 Work is due for review.")).toBeNull();
  });

  it("marks a paused Work and reports nothing due when no card is due", async () => {
    mockedFetch.mockResolvedValue({
      dueCount: 0,
      works: [
        {
          isDue: false,
          nextReviewAt: "2026-08-15T09:00:00.000Z",
          paused: true,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "Paused Work"
        }
      ]
    });

    renderPage();

    expect(await screen.findByText("Nothing is due right now.")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Start due review" })).toBeNull();
    const list = screen.getByRole("list", { name: "Enrolled Works" });
    expect(within(list).getByText("Paused")).toBeDefined();
  });

  it("labels a removed-maintenance Work as not scheduled", async () => {
    mockedFetch.mockResolvedValue({
      dueCount: 0,
      works: [
        {
          isDue: false,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: null,
          workEntryId: "work-1",
          workTitle: "Retired Work"
        }
      ]
    });

    renderPage();

    const list = await screen.findByRole("list", { name: "Enrolled Works" });
    expect(within(list).getByText("Not scheduled")).toBeDefined();
  });

  it("shows a calm empty state pointing to the Library when nothing is enrolled", async () => {
    mockedFetch.mockResolvedValue({ dueCount: 0, works: [] });

    renderPage();

    expect(await screen.findByText(/haven’t enrolled any Works yet/)).toBeDefined();
    const toLibrary = screen.getByRole("link", { name: "Go to Library" });
    expect(toLibrary.getAttribute("href")).toBe("/library");
    expect(screen.queryByRole("list", { name: "Enrolled Works" })).toBeNull();
  });

  it("surfaces a retryable message when the overview cannot load", async () => {
    mockedFetch.mockRejectedValue(new Error("offline"));

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn’t load your recitation/);
  });
});
