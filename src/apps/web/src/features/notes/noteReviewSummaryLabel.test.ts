import { describe, expect, it } from "vitest";

import type { NoteReviewSummaryDto } from "@whetstone/contracts";

import { reviewSummaryLabel } from "./noteReviewSummaryLabel";

const NY = "America/New_York";
const now = new Date("2026-07-19T20:00:00.000Z"); // 4:00 PM EDT

describe("reviewSummaryLabel", () => {
  it("labels a single due prompt without a count", () => {
    const review: NoteReviewSummaryDto = { dueCount: 1, status: "due" };
    expect(reviewSummaryLabel(review, now, NY)).toBe("Review due");
  });

  it("labels multiple due prompts with the count", () => {
    const review: NoteReviewSummaryDto = { dueCount: 3, status: "due" };
    expect(reviewSummaryLabel(review, now, NY)).toBe("Review due (3)");
  });

  it("labels a scheduled note with the shared next-review when-phrase in the learner''s zone", () => {
    const review: NoteReviewSummaryDto = {
      nextReviewAt: "2026-07-25T13:30:00.000Z",
      status: "scheduled"
    };
    expect(reviewSummaryLabel(review, now, NY)).toBe("Next review \u00b7 July 25, 2026 at 9:30 AM");
  });

  it("shows a same-day scheduled instant as a local time, not a bare date (#676)", () => {
    const review: NoteReviewSummaryDto = {
      nextReviewAt: "2026-07-19T20:10:00.000Z",
      status: "scheduled"
    };
    expect(reviewSummaryLabel(review, now, NY)).toBe("Next review \u00b7 Later today at 4:10 PM");
  });

  it("labels a paused note", () => {
    expect(reviewSummaryLabel({ status: "paused" }, now, NY)).toBe("Paused");
  });

  it("invites enrollment for an un-enrolled note", () => {
    expect(reviewSummaryLabel({ status: "not_enrolled" }, now, NY)).toBe("Add to review");
  });
});
