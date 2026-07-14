import {
  applyRating,
  assertRequestedRetention,
  newReviewState,
  type ReviewRating,
  type ReviewState
} from "@whetstone/domain";
import { eq, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { reviewCards, reviewEvents } from "../../db/schema.js";
import {
  getReviewCardForUser,
  reviewStateColumns,
  reviewStateFromCard,
  type ReviewCardRow
} from "./reviewCardQueries.js";

// The transaction handle drizzle passes into `db.transaction`, so a card write can compose inside a
// caller's transaction (a Memory deposit/edit/delete) or run in the substrate's own transaction.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Real infrastructure boundaries injected so the substrate stays deterministic and testable: the
// database client and id generation (the id stamped on each appended review event). `now` is always
// passed in explicitly and feeds the pure FSRS scheduler.
export type ReviewCardDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
}>;

// A card-mutating result: the updated card, or `not_found` when the target has no card owned by the user.
export type RateReviewCardResult =
  | Readonly<{ card: ReviewCardRow; state: ReviewState; status: "rated" }>
  | Readonly<{ status: "not_found" }>;

export type RestartReviewCardResult =
  | Readonly<{ card: ReviewCardRow; state: ReviewState; status: "restarted" }>
  | Readonly<{ status: "not_found" }>;

export type ReviewCardTransitionResult =
  | Readonly<{ card: ReviewCardRow; status: "updated" }>
  | Readonly<{ status: "not_found" }>;

// How far a snooze defers a card by default: one day, so it leaves today's batch and reappears tomorrow.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Seed a fresh active card for a target inside the caller's transaction (#617): a brand-new FSRS state,
// due immediately, at the resolved requested-retention policy the seeding caller chose. Validates the
// policy at this boundary so an out-of-range retention never lands in a card. Returns the seeded
// `ReviewState` so the caller can project the new card without a re-read. It is a defect to seed a second
// card for a target that already has one — enrollment is one-to-one.
export async function seedReviewCard(
  tx: Transaction,
  params: Readonly<{
    targetEntryId: string;
    userId: string;
    requestedRetention: number;
    now: Date;
  }>
): Promise<ReviewState> {
  assertRequestedRetention(params.requestedRetention);
  const state = newReviewState(params.now);
  await tx.insert(reviewCards).values({
    targetEntryId: params.targetEntryId,
    userId: params.userId,
    status: "active",
    requestedRetention: params.requestedRetention,
    createdAt: params.now,
    updatedAt: params.now,
    ...reviewStateColumns(state)
  });
  return state;
}

// Drop a target's card inside the caller's transaction, leaving its append-only review events intact —
// used when an edit unenrolls a target (its content is no longer reviewable). The history survives so a
// later re-enrollment keeps the target's past review record.
export async function deleteReviewCard(tx: Transaction, targetEntryId: string): Promise<void> {
  await tx.delete(reviewCards).where(eq(reviewCards.targetEntryId, targetEntryId));
}

// Remove the cards AND the append-only events for a set of targets inside the caller's transaction —
// used when the targets themselves are being deleted (a Memory note/prompt delete), so no orphaned
// schedule or history outlives the target Entry. Events are removed first (they reference the Entry).
export async function deleteReviewCardsAndEvents(
  tx: Transaction,
  targetEntryIds: ReadonlyArray<string>
): Promise<void> {
  if (targetEntryIds.length === 0) {
    return;
  }
  const ids = [...targetEntryIds];
  await tx.delete(reviewEvents).where(inArray(reviewEvents.targetEntryId, ids));
  await tx.delete(reviewCards).where(inArray(reviewCards.targetEntryId, ids));
}

// Apply a learner's rating to a target's card (#617): schedule the next review with the card's OWN stored
// requested retention (never a global assumption, never switching on target type), overwrite the card's
// FSRS state, and append exactly one `rating` review event — atomically, in one transaction. A target
// with no card owned by the user is `not_found`.
export async function rateReviewCard(
  dependencies: ReviewCardDependencies,
  targetEntryId: string,
  userId: string,
  rating: ReviewRating,
  now: Date
): Promise<RateReviewCardResult> {
  const card = await getReviewCardForUser(dependencies.db, targetEntryId, userId);
  if (card === undefined) {
    return { status: "not_found" };
  }
  const state = applyRating(reviewStateFromCard(card), rating, now, card.requestedRetention);
  const columns = reviewStateColumns(state);
  const eventId = dependencies.createId();
  await dependencies.db.transaction(async (tx) => {
    await tx
      .update(reviewCards)
      .set({ ...columns, updatedAt: now })
      .where(eq(reviewCards.targetEntryId, targetEntryId));
    await tx.insert(reviewEvents).values({
      id: eventId,
      targetEntryId,
      type: "rating",
      rating,
      occurredAt: now
    });
  });
  return { card: { ...card, ...columns, updatedAt: now }, state, status: "rated" };
}

// Explicitly restart a target's schedule (#617): reset the card to a brand-new FSRS state (keeping its
// owner, requested retention, and status), and append exactly one `reset` review event — atomically, in
// one transaction, and WITHOUT inventing a rating. A target with no card owned by the user is `not_found`.
export async function restartReviewCard(
  dependencies: ReviewCardDependencies,
  targetEntryId: string,
  userId: string,
  now: Date
): Promise<RestartReviewCardResult> {
  const card = await getReviewCardForUser(dependencies.db, targetEntryId, userId);
  if (card === undefined) {
    return { status: "not_found" };
  }
  const state = newReviewState(now);
  const columns = reviewStateColumns(state);
  const eventId = dependencies.createId();
  await dependencies.db.transaction(async (tx) => {
    await tx
      .update(reviewCards)
      .set({ ...columns, updatedAt: now })
      .where(eq(reviewCards.targetEntryId, targetEntryId));
    await tx.insert(reviewEvents).values({
      id: eventId,
      targetEntryId,
      type: "reset",
      rating: null,
      occurredAt: now
    });
  });
  return { card: { ...card, ...columns, updatedAt: now }, state, status: "restarted" };
}

// Defer a target's card OUT of today's batch by moving ONLY its `due_at` forward (default one day). It is
// NOT a review: the FSRS card state is left untouched and NO review event is appended, so the schedule is
// unchanged. A target with no card owned by the user is `not_found`.
export async function snoozeReviewCard(
  db: DbClient,
  targetEntryId: string,
  userId: string,
  now: Date,
  deferDays = 1
): Promise<ReviewCardTransitionResult> {
  const card = await getReviewCardForUser(db, targetEntryId, userId);
  if (card === undefined) {
    return { status: "not_found" };
  }
  const dueAt = new Date(now.getTime() + deferDays * MS_PER_DAY);
  await db
    .update(reviewCards)
    .set({ dueAt, updatedAt: now })
    .where(eq(reviewCards.targetEntryId, targetEntryId));
  return { card: { ...card, dueAt, updatedAt: now }, status: "updated" };
}

// Set a target's card status without appending a review event (#617): pause withholds an active card from
// the due scan; resume returns a paused card to it. Neither touches the FSRS state. A target with no card
// owned by the user is `not_found`.
async function setCardStatus(
  db: DbClient,
  targetEntryId: string,
  userId: string,
  now: Date,
  status: "active" | "paused"
): Promise<ReviewCardTransitionResult> {
  const card = await getReviewCardForUser(db, targetEntryId, userId);
  if (card === undefined) {
    return { status: "not_found" };
  }
  await db
    .update(reviewCards)
    .set({ status, updatedAt: now })
    .where(eq(reviewCards.targetEntryId, targetEntryId));
  return { card: { ...card, status, updatedAt: now }, status: "updated" };
}

export function pauseReviewCard(
  db: DbClient,
  targetEntryId: string,
  userId: string,
  now: Date
): Promise<ReviewCardTransitionResult> {
  return setCardStatus(db, targetEntryId, userId, now, "paused");
}

export function resumeReviewCard(
  db: DbClient,
  targetEntryId: string,
  userId: string,
  now: Date
): Promise<ReviewCardTransitionResult> {
  return setCardStatus(db, targetEntryId, userId, now, "active");
}
