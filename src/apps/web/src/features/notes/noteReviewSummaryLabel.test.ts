import { describe, expect, it } from "vitest";

import type { NoteReviewSummaryDto } from "@whetstone/contracts";

import { formatReviewDate, reviewSummaryLabel } from "./noteReviewSummaryLabel";

describe("reviewSummaryLabel", () => {
  it("labels a single due prompt without a count", () => {
    const review: NoteReviewSummaryDto = { dueCount: 1, status: "due" };
    expect(reviewSummaryLabel(review)).toBe("Review due");
  });

  it("labels multiple due prompts with the count", () => {
    const review: NoteReviewSummaryDto = { dueCount: 3, status: "due" };
    expect(reviewSummaryLabel(review)).toBe("Review due (3)");
  });

  it("labels a scheduled note with its localized next-review date", () => {
    const review: NoteReviewSummaryDto = {
      nextReviewAt: "2026-03-03T00:00:00.000Z",
      status: "scheduled"
    };
    expect(reviewSummaryLabel(review)).toBe(
      `Next review · ${formatReviewDate(review.nextReviewAt)}`
    );
  });

  it("labels a paused note", () => {
    expect(reviewSummaryLabel({ status: "paused" })).toBe("Paused");
  });

  it("invites enrollment for an un-enrolled note", () => {
    expect(reviewSummaryLabel({ status: "not_enrolled" })).toBe("Add to review");
  });
});

describe("formatReviewDate", () => {
  it("renders a long, human date", () => {
    expect(formatReviewDate("2026-03-03T00:00:00.000Z")).toContain("2026");
  });
});
