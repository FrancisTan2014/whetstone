// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationApi", () => ({
  recordRecitationReview: vi.fn()
}));

import type { RecitationReviewDto, RecordRecitationReviewResponse } from "@whetstone/contracts";

import { recordRecitationReview } from "./recitationApi";
import { RecitationReviewCard } from "./RecitationReviewCard";

const mockedRecord = vi.mocked(recordRecitationReview);

const review: RecitationReviewDto = {
  dueAt: "2026-07-01T09:00:00.000Z",
  planEntryId: "plan-1",
  sourceText: "The North Wind and the Sun disputed which was the stronger.",
  state: "review",
  workEntryId: "work-1",
  workTitle: "Aesop’s Fables"
};

function nextReview(overrides: Partial<RecitationReviewDto> = {}): RecordRecitationReviewResponse {
  return { review: { ...review, dueAt: "2026-07-05T09:00:00.000Z", ...overrides } };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecitationReviewCard", () => {
  it("asks the learner to recite the Work and hides the source until revealed", () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} review={review} />);

    expect(screen.getByText(/Recite/).textContent).toContain("Aesop’s Fables");
    expect(screen.queryByLabelText("Source")).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete, with effort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeDefined();
  });

  it("reveals the canonical source and the four ratings after Reveal", async () => {
    const user = userEvent.setup();
    render(<RecitationReviewCard onReviewed={vi.fn()} review={review} />);

    await user.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByLabelText("Source").textContent).toBe(review.sourceText);
    for (const label of [
      "Couldn't continue",
      "Needed cues",
      "Complete, with effort",
      "Clean and natural"
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  it("records the rating for this plan and hands back the rescheduled review", async () => {
    const user = userEvent.setup();
    mockedRecord.mockResolvedValue(nextReview());
    const onReviewed = vi.fn();
    render(<RecitationReviewCard onReviewed={onReviewed} review={review} />);

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await user.click(screen.getByRole("button", { name: "Complete, with effort" }));

    expect(mockedRecord).toHaveBeenCalledWith("plan-1", "good");
    expect(onReviewed).toHaveBeenCalledWith(nextReview().review);
  });

  it("surfaces a retry message and does not advance when recording fails", async () => {
    const user = userEvent.setup();
    mockedRecord.mockRejectedValue(new Error("boom"));
    const onReviewed = vi.fn();
    render(<RecitationReviewCard onReviewed={onReviewed} review={review} />);

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await user.click(screen.getByRole("button", { name: "Couldn't continue" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Could not save that rating");
    expect(onReviewed).not.toHaveBeenCalled();
  });
});
