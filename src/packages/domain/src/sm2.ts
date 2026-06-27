// A pure, deterministic SM-2 spaced-repetition scheduler (#188). Given an item's review state and a
// grade, `scheduleReview` returns the next review state. No persistence, LLM, UI, or network: time
// enters only via a passed-in `now`, and the returned state is frozen (never a mutation of the input).
//
// The grade is source-agnostic: it can be a learner's self-rating today or an LLM-assessed score
// later — the scheduler never changes when the LLM starts participating (the LLM *grades*, SM-2
// *schedules*). The `(state, grade, now) -> state` signature is kept FSRS-compatible so a different
// algorithm can be swapped in behind it later without touching callers.

// SM-2 recall quality, 0..5 (0 = total blackout, 5 = perfect). A grade below 3 is a lapse.
export type ReviewGrade = 0 | 1 | 2 | 3 | 4 | 5;

// The four-button rating commonly shown to a learner, mapped onto the SM-2 0..5 quality scale.
export type ReviewRating = "again" | "hard" | "good" | "easy";

export type ReviewState = Readonly<{
  // Multiplier applied to the interval once an item is past its first two reviews. Starts at 2.5 and
  // is floored at 1.3 so a hard item never collapses to same-day reviews.
  easeFactor: number;
  // Days until the item is next due (0 for a brand-new item that is due immediately).
  intervalDays: number;
  // Consecutive successful reviews; reset to 0 on a lapse.
  repetitions: number;
  // How many times the item has lapsed (graded below 3); only ever increases.
  lapses: number;
  // ISO-8601 instant of the most recent review, or null for an item that has never been reviewed.
  lastReviewedAt: string | null;
  // ISO-8601 instant the item is next due (= last review + intervalDays, or `now` for a new item).
  dueAt: string;
}>;

const INITIAL_EASE_FACTOR = 2.5;
const MINIMUM_EASE_FACTOR = 1.3;
const FIRST_INTERVAL_DAYS = 1;
const SECOND_INTERVAL_DAYS = 6;
const PASSING_GRADE: ReviewGrade = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ratingToGrade: Readonly<Record<ReviewRating, ReviewGrade>> = Object.freeze({
  again: 0,
  hard: 3,
  good: 4,
  easy: 5
});

// Map a learner's (or an LLM's) four-button rating onto the SM-2 0..5 quality scale.
export function gradeFromRating(rating: ReviewRating): ReviewGrade {
  return ratingToGrade[rating];
}

// A fresh item: default ease, no history, due immediately at `now`.
export function newReviewState(now: Date): ReviewState {
  return Object.freeze({
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    lastReviewedAt: null,
    dueAt: now.toISOString()
  });
}

// Apply SM-2 to produce the next state. Deterministic given `(state, grade, now)`.
export function scheduleReview(state: ReviewState, grade: ReviewGrade, now: Date): ReviewState {
  assertGrade(grade);

  const easeFactor = nextEaseFactor(state.easeFactor, grade);

  if (grade < PASSING_GRADE) {
    // Lapse: drop back to the first interval, reset the streak, count the lapse. The ease still
    // moves (downward) so a repeatedly-failed item keeps getting easier-graded reviews.
    return buildState({
      easeFactor,
      intervalDays: FIRST_INTERVAL_DAYS,
      repetitions: 0,
      lapses: state.lapses + 1,
      now
    });
  }

  return buildState({
    easeFactor,
    intervalDays: nextIntervalDays(state, easeFactor),
    repetitions: state.repetitions + 1,
    lapses: state.lapses,
    now
  });
}

// SM-2 ease update, floored at 1.3. good (4) holds ease steady, easy (5) raises it, anything lower
// lowers it.
function nextEaseFactor(easeFactor: number, grade: ReviewGrade): number {
  const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
  return Math.max(MINIMUM_EASE_FACTOR, easeFactor + delta);
}

// Interval progression on a successful review: first review -> 1 day, second -> 6 days, thereafter
// the previous interval grown by the (already-updated) ease factor.
function nextIntervalDays(state: ReviewState, easeFactor: number): number {
  if (state.repetitions === 0) {
    return FIRST_INTERVAL_DAYS;
  }

  if (state.repetitions === 1) {
    return SECOND_INTERVAL_DAYS;
  }

  return Math.round(state.intervalDays * easeFactor);
}

function buildState(input: {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  now: Date;
}): ReviewState {
  return Object.freeze({
    easeFactor: input.easeFactor,
    intervalDays: input.intervalDays,
    repetitions: input.repetitions,
    lapses: input.lapses,
    lastReviewedAt: input.now.toISOString(),
    dueAt: new Date(input.now.getTime() + input.intervalDays * MS_PER_DAY).toISOString()
  });
}

function assertGrade(grade: number): void {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) {
    throw new Error("SM-2 grade must be an integer between 0 and 5.");
  }
}
