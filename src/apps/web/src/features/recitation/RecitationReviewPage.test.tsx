// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationApi", () => ({
  fetchRecitationReview: vi.fn(),
  recordRecitationReview: vi.fn()
}));

import type { RecitationReviewDto } from "@whetstone/contracts";

import { fetchRecitationReview, recordRecitationReview } from "./recitationApi";
import { RecitationReviewPage } from "./RecitationReviewPage";

const mockedFetch = vi.mocked(fetchRecitationReview);
const mockedRecord = vi.mocked(recordRecitationReview);

const review: RecitationReviewDto = {
  dueAt: "2026-07-01T09:00:00.000Z",
  planEntryId: "plan-1",
  sourceText: "The North Wind and the Sun.",
  state: "review",
  workEntryId: "work-1",
  workTitle: "Aesop’s Fables"
};

function renderPage(workEntryId?: string): void {
  render(
    <MemoryRouter>
      <RecitationReviewPage workEntryId={workEntryId} />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecitationReviewPage", () => {
  it("opens the given Work's review and rates through to Due complete when nothing else is due", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({ review });
    mockedRecord.mockResolvedValue({
      remainingDueCount: 0,
      review: { ...review, dueAt: "2026-07-08T09:00:00.000Z" }
    });

    renderPage("work-1");

    await screen.findByText(/Recite/);
    expect(mockedFetch).toHaveBeenCalledWith("work-1");

    await user.click(screen.getByRole("button", { name: "Reveal source" }));
    await user.click(screen.getByRole("button", { name: "Complete, with effort" }));

    const status = await screen.findByText("Due complete.");
    expect(status).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Aesop’s Fables");
    expect(screen.getByRole("status").textContent).toContain("2026-07-08");
    expect(screen.queryByRole("button", { name: "Review next" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Today" }).getAttribute("href")).toBe("/");
  });

  it("offers an optional Review next that reloads the earliest-due Work while others remain due", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({ review });
    mockedRecord.mockResolvedValue({
      remainingDueCount: 2,
      review: { ...review, dueAt: "2026-07-08T09:00:00.000Z" }
    });

    renderPage("work-1");

    await screen.findByText(/Recite/);
    await user.click(screen.getByRole("button", { name: "Reveal source" }));
    await user.click(screen.getByRole("button", { name: "Complete, with effort" }));

    await screen.findByRole("button", { name: "Review next" });
    expect(screen.queryByText("Due complete.")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Today" }).getAttribute("href")).toBe("/");

    const nextWork: RecitationReviewDto = {
      ...review,
      workEntryId: "work-2",
      workTitle: "Analects"
    };
    mockedFetch.mockResolvedValue({ review: nextWork });

    await user.click(screen.getByRole("button", { name: "Review next" }));

    await screen.findByText(/Recite/);
    expect(mockedFetch).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText(/Recite/).textContent).toContain("Analects");
  });

  it("requests the earliest-due review when no Work is given", async () => {
    mockedFetch.mockResolvedValue({ review });

    renderPage();

    await screen.findByText(/Recite/);
    expect(mockedFetch).toHaveBeenCalledWith(undefined);
  });

  it("shows a calm Library recovery when nothing is due", async () => {
    mockedFetch.mockResolvedValue({ review: null });

    renderPage("work-1");

    expect(await screen.findByText(/No recitation is due/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Library" }).getAttribute("href")).toBe(
      "/library"
    );
  });

  it("shows an error message when the review cannot be loaded", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));

    renderPage("work-1");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t load your recitation"
    );
  });
});
