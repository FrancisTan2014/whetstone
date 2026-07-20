import type { NotePromptCardStateDto, NotePromptRevealPolicyDto } from "@whetstone/contracts";
import { formatNextReviewLabel } from "@whetstone/domain";

// The objective state label a card shows, derived from its projected card state (never persisted). A
// scheduled card's when-phrase is the ONE shared next-review projection (#676), resolved in the learner's
// zone, so a card scheduled later the same day reads "Next review · Later today at <time>", not a bare date.
export function cardStateLabel(
  cardState: NotePromptCardStateDto,
  now: Date,
  timeZone: string
): string {
  switch (cardState.state) {
    case "due":
      return "Due now";
    case "scheduled":
      return `Next review · ${formatNextReviewLabel({ due: new Date(cardState.nextReviewAt), now, timeZone })}`;
    case "paused":
      return "Paused";
    case "not_in_review":
      return "Not in review";
  }
}

// The compact reveal-kind label a Cards list row shows next to the question, so the learner can tell at a
// glance what a card reveals without opening it: the live note itself, an authored success check, or a
// preserved legacy answer (#657 legacy reveals are read-only and never converted).
export function revealSummaryLabel(reveal: NotePromptRevealPolicyDto): string {
  switch (reveal.kind) {
    case "current_note":
      return "Whole note";
    case "expected_response":
      return "Specific success check";
    case "legacy_custom":
      return "Legacy answer";
  }
}
