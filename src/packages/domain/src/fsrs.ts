// The pure, deterministic scheduler boundary (#572): a thin wrapper over the maintained MIT `ts-fsrs`
// library (FSRS v6). Given an item's review state and one of the four ratings, `applyRating` returns
// the next review state. No persistence, LLM, UI, or network: time enters only via a passed-in `now`,
// and every returned state is frozen (never a mutation of the input).
//
// This owns the ONLY scheduler vocabulary: the four FSRS ratings again/hard/good/easy. It never
// reimplements an FSRS formula — the library does the maths; this module only maps between the
// library's mutable `Card` (Date-typed, numeric `State`) and our immutable, serialisable `ReviewState`
// (ISO-8601 instants, string `CardState`) so the rest of the app depends inward on a stable shape.

import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from "ts-fsrs";

// A learner's (or an LLM's) four-button rating of a recall attempt — the whole grade vocabulary.
export type ReviewRating = "again" | "hard" | "good" | "easy";

// The FSRS card lifecycle: a brand-new card, one in its initial learning steps, a graduated card in
// long-term review, or a lapsed card being relearned. Mirrors `ts-fsrs`'s `State` enum as strings so
// the persisted/serialised shape is stable and human-readable.
export const cardStates = ["new", "learning", "review", "relearning"] as const;

export type CardState = (typeof cardStates)[number];

// The complete FSRS card state, serialisable and immutable. Every field the library needs to schedule
// the next review is carried, so a state round-trips through `toCard`/`fromCard` with no approximate
// reconstruction. `due` is when the item is next up; `lastReviewedAt` is null until the first review.
export type ReviewState = Readonly<{
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: CardState;
  lastReviewedAt: string | null;
}>;

// The default requested retention a seeding caller applies when it has no reason to choose another
// (#617). It is only a *seed* default now: `applyRating` no longer assumes it — the requested retention
// is an explicit input, resolved per card from the stored policy — so a consumer may schedule a target
// at a different retention without this module knowing which feature owns it.
export const RECALL_REQUEST_RETENTION = 0.9;

// The requested retention is a probability strictly between 0 and 1: 0 or 1 (or anything outside) is not
// an achievable retention target and would make the scheduler's interval maths meaningless. Validated
// here, at the scheduler boundary, so no caller can drive FSRS with an out-of-range policy.
export function assertRequestedRetention(requestedRetention: number): void {
  if (!(requestedRetention > 0 && requestedRetention < 1)) {
    throw new RangeError("requestedRetention must satisfy 0 < requestedRetention < 1.");
  }
}

// Scheduler options. Production leaves fuzz ON (small random interval jitter that de-synchronises
// batches); tests pass `enableFuzz: false` for deterministic intervals.
export type SchedulerOptions = Readonly<{ enableFuzz?: boolean }>;

// Bidirectional, frozen map between the library's numeric `State` enum and our `CardState` strings.
const cardStateByEnum: Readonly<Record<State, CardState>> = Object.freeze({
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning"
});

const enumByCardState: Readonly<Record<CardState, State>> = Object.freeze({
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning
});

const enumByRating: Readonly<Record<ReviewRating, Grade>> = Object.freeze({
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy
});

// The FSRS scheduler instance for the given requested retention and options. The requested retention is
// an explicit input (#617) — validated here so an out-of-range policy never reaches the library — and
// fuzz stays independently configurable so tests can request deterministic intervals.
function scheduler(requestedRetention: number, options?: SchedulerOptions) {
  assertRequestedRetention(requestedRetention);
  return fsrs({
    request_retention: requestedRetention,
    enable_fuzz: options?.enableFuzz ?? true
  });
}

// Map our immutable `ReviewState` onto the library's `Card` (ISO -> Date, string state -> enum).
function toCard(state: ReviewState): Card {
  const card: Card = {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsedDays,
    scheduled_days: state.scheduledDays,
    learning_steps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: enumByCardState[state.state]
  };
  if (state.lastReviewedAt !== null) {
    card.last_review = new Date(state.lastReviewedAt);
  }
  return card;
}

// Map a library `Card` back onto a frozen `ReviewState` (Date -> ISO, enum -> string state).
function fromCard(card: Card): ReviewState {
  return Object.freeze({
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: cardStateByEnum[card.state],
    lastReviewedAt: card.last_review === undefined ? null : card.last_review.toISOString()
  });
}

// A fresh item: an empty FSRS card, due immediately at `now`, never reviewed.
export function newReviewState(now: Date): ReviewState {
  return fromCard(createEmptyCard(now));
}

// Apply a rating to produce the next state, optimising intervals for the given requested retention
// (#617) — the caller resolves it from the target's stored policy, never a global assumption.
// Deterministic given `(state, rating, now, requestedRetention)` when fuzz is off. The input is never
// mutated; the result is frozen.
export function applyRating(
  state: ReviewState,
  rating: ReviewRating,
  now: Date,
  requestedRetention: number,
  options?: SchedulerOptions
): ReviewState {
  return fromCard(
    scheduler(requestedRetention, options).next(toCard(state), now, enumByRating[rating]).card
  );
}

// Whether the item is due for review at `now` (its due instant has arrived).
export function isDue(state: ReviewState, now: Date): boolean {
  return new Date(state.due).getTime() <= now.getTime();
}

// The FSRS retrievability at `now`: the estimated probability (0..1) the learner still recalls the
// item. Independent of the requested retention (which only shapes next-interval length), so the seed
// default is used purely to obtain a scheduler instance.
export function retrievability(state: ReviewState, now: Date): number {
  return scheduler(RECALL_REQUEST_RETENTION).get_retrievability(toCard(state), now, false);
}
