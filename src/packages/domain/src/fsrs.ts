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

// The single v0 scheduler parameter: the requested retention the scheduler optimises intervals for.
export const RECALL_REQUEST_RETENTION = 0.9;

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

// The FSRS scheduler instance for the given options. Centralises the v0 parameters (requested
// retention 0.9) so every scheduled prompt goes through one boundary.
function scheduler(options?: SchedulerOptions) {
  return fsrs({
    request_retention: RECALL_REQUEST_RETENTION,
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

// Apply a rating to produce the next state. Deterministic given `(state, rating, now)` when fuzz is
// off. The input is never mutated; the result is frozen.
export function applyRating(
  state: ReviewState,
  rating: ReviewRating,
  now: Date,
  options?: SchedulerOptions
): ReviewState {
  return fromCard(scheduler(options).next(toCard(state), now, enumByRating[rating]).card);
}

// Whether the item is due for review at `now` (its due instant has arrived).
export function isDue(state: ReviewState, now: Date): boolean {
  return new Date(state.due).getTime() <= now.getTime();
}

// The FSRS retrievability at `now`: the estimated probability (0..1) the learner still recalls the
// item. Decreases as time passes since the last review.
export function retrievability(state: ReviewState, now: Date): number {
  return scheduler().get_retrievability(toCard(state), now, false);
}
