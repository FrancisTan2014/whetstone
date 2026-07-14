// Recitation new-passage pacing (#607): the pure availability rule for introducing the next queued
// passage in a Learning plan. Introduction is explicit and paced — at most a few new passages per learner
// LOCAL day (#606), and never while an already-introduced passage is still due — so a learner is never
// handed an accidental backlog. This module is the single source of that decision; time, the local-day
// boundary, and persistence enter elsewhere.

// How many new passages a learner may introduce per local calendar day. A calm ceiling, not a streak
// target: reaching it is a resting state ("3 of 3 introduced today"), never a failure.
export const RECITATION_DAILY_INTRODUCTION_CAP = 3;

// Why "New passage" is or is not offered right now. `available` means it can be introduced; every other
// value is the single, machine-readable reason it cannot, so the UI can render the exact calm state. The
// tuple is the shared vocabulary contracts validate against, so DTO and domain never drift.
export const recitationIntroductionReasons = [
  "available",
  "not_learning",
  "due_work_remains",
  "cap_reached",
  "all_introduced"
] as const;

export type RecitationIntroductionReason = (typeof recitationIntroductionReasons)[number];

export type RecitationIntroductionAvailability = Readonly<{
  dailyCap: number;
  remainingCapacity: number;
  newPassageAvailable: boolean;
  reason: RecitationIntroductionReason;
}>;

type RecitationIntroductionInput = Readonly<{
  isLearning: boolean;
  dueCount: number;
  introducedToday: number;
  hasQueued: boolean;
}>;

// The first blocking condition in fixed precedence, or `available` when none blocks. Due work is checked
// before the cap so a learner is always steered to practise an introduced passage before being told the
// cap is reached; running out of queued passages is reported as `all_introduced` rather than a cap state.
function resolveReason(input: RecitationIntroductionInput): RecitationIntroductionReason {
  if (!input.isLearning) {
    return "not_learning";
  }
  if (input.dueCount > 0) {
    return "due_work_remains";
  }
  if (!input.hasQueued) {
    return "all_introduced";
  }
  if (input.introducedToday >= RECITATION_DAILY_INTRODUCTION_CAP) {
    return "cap_reached";
  }
  return "available";
}

// Evaluate whether the learner may introduce the next queued passage, and how much daily capacity
// remains. `remainingCapacity` never goes below zero even if more than the cap were somehow introduced.
// `newPassageAvailable` is true iff the reason is `available`, so the flag and the reason can never
// disagree.
export function evaluateRecitationIntroduction(
  input: RecitationIntroductionInput
): RecitationIntroductionAvailability {
  const remainingCapacity = Math.max(0, RECITATION_DAILY_INTRODUCTION_CAP - input.introducedToday);
  const reason = resolveReason(input);
  return {
    dailyCap: RECITATION_DAILY_INTRODUCTION_CAP,
    newPassageAvailable: reason === "available",
    reason,
    remainingCapacity
  };
}
