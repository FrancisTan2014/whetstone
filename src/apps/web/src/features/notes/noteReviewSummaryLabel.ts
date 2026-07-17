import type { NoteReviewSummaryDto } from "@whetstone/contracts";

// Localize a review instant as a calm date, e.g. "3 March 2026". Shared by the row projection and the
// editor's section so the two never drift.
export function formatReviewDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

// The single Review label a Notes-home row shows, in the fixed precedence (#659): a due note leads with
// "Review due" (with the count only when more than one prompt is due), then a scheduled note shows
// "Next review · <date>", then a paused note shows "Paused", and an un-enrolled note invites "Add to
// review". The row shows text (never color alone) so the state is legible at AA contrast in Day and Night.
export function reviewSummaryLabel(review: NoteReviewSummaryDto): string {
  switch (review.status) {
    case "due":
      return review.dueCount > 1 ? `Review due (${review.dueCount})` : "Review due";
    case "scheduled":
      return `Next review · ${formatReviewDate(review.nextReviewAt)}`;
    case "paused":
      return "Paused";
    case "not_enrolled":
      return "Add to review";
  }
}
