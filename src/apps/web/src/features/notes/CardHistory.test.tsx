// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  fetchNotePromptHistory: vi.fn()
}));

import type { ReviewHistoryEventDto } from "@whetstone/contracts";

import { CardHistory } from "./CardHistory";
import { fetchNotePromptHistory } from "../notesReview/notesReviewApi";

const mockedHistory = vi.mocked(fetchNotePromptHistory);

function rating(id: string, r: "again" | "hard" | "good" | "easy"): ReviewHistoryEventDto {
  return { id, kind: "rating", occurredAt: "2026-07-01T09:30:00.000Z", rating: r };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("CardHistory", () => {
  it("renders each rating and reset event newest-first", async () => {
    mockedHistory.mockResolvedValue({
      events: [
        rating("e1", "again"),
        rating("e2", "hard"),
        rating("e3", "good"),
        rating("e4", "easy"),
        { id: "e5", kind: "reset", occurredAt: "2026-07-01T08:00:00.000Z" }
      ],
      nextCursor: null
    });
    render(<CardHistory promptId="prompt-1" />);

    expect(await screen.findByText("Rated Again")).toBeDefined();
    expect(screen.getByText("Rated Hard")).toBeDefined();
    expect(screen.getByText("Rated Good")).toBeDefined();
    expect(screen.getByText("Rated Easy")).toBeDefined();
    expect(screen.getByText("Schedule restarted")).toBeDefined();
    // No further page, so no "Load older" control.
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("shows the empty state when a card has no history", async () => {
    mockedHistory.mockResolvedValue({ events: [], nextCursor: null });
    render(<CardHistory promptId="prompt-1" />);
    expect(await screen.findByText("No review history yet.")).toBeDefined();
  });

  it("appends the next page when Load older is used, then hides the control at the end", async () => {
    mockedHistory.mockResolvedValueOnce({ events: [rating("e1", "good")], nextCursor: "cursor-2" });
    mockedHistory.mockResolvedValueOnce({ events: [rating("e2", "easy")], nextCursor: null });
    render(<CardHistory promptId="prompt-1" />);

    await screen.findByText("Rated Good");
    await userEvent.click(screen.getByRole("button", { name: "Load older" }));

    expect(await screen.findByText("Rated Easy")).toBeDefined();
    expect(screen.getByText("Rated Good")).toBeDefined();
    expect(mockedHistory).toHaveBeenLastCalledWith("prompt-1", "cursor-2");
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("recovers from a first-page failure via Retry", async () => {
    mockedHistory.mockRejectedValueOnce(new Error("boom"));
    mockedHistory.mockResolvedValueOnce({ events: [rating("e1", "good")], nextCursor: null });
    render(<CardHistory promptId="prompt-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Rated Good")).toBeDefined();
  });

  it("surfaces an error when loading an older page fails", async () => {
    mockedHistory.mockResolvedValueOnce({ events: [rating("e1", "good")], nextCursor: "cursor-2" });
    mockedHistory.mockRejectedValueOnce(new Error("offline"));
    render(<CardHistory promptId="prompt-1" />);

    await screen.findByText("Rated Good");
    await userEvent.click(screen.getByRole("button", { name: "Load older" }));

    expect(await screen.findByText("Could not load the review history.")).toBeDefined();
  });
});
