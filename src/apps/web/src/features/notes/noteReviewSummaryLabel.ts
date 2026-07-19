import type { NoteReviewSummaryDto } from "@whetstone/contracts";
import { formatNextReviewLabel } from "@whetstone/domain";

// The single Review label a Notes-home row shows, in the fixed precedence (#659): a due note leads with
// "Review due" (with the count only when more than one prompt is due), then a scheduled note shows
// "Next review · <when>", then a paused note shows "Paused", and an un-enrolled note invites "Add to
// review". The scheduled when-phrase is the ONE shared next-review projection (#676), resolved in the
// learner's zone, so a card scheduled later the same day reads "Next review · Later today at <time>"
// rather than a bare date that looks like today. The row shows text (never color alone) so the state is
// legible at AA contrast in Day and Night.
export function reviewSummaryLabel(
  review: NoteReviewSummaryDto,
  now: Date,
  timeZone: string
): string {
  switch (review.status) {
    case "due":
      return review.dueCount > 1 ? `Review due (${review.dueCount})` : "Review due";
    case "scheduled":
      return `Next review · ${formatNextReviewLabel({ due: new Date(review.nextReviewAt), now, timeZone })}`;
    case "paused":
      return "Paused";
    case "not_enrolled":
      return "Add to review";
  }
}
