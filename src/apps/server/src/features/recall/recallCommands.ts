import type { EnrollRecallItemRequest, RecallItemDto } from "@whetstone/contracts";
import { newReviewState, scheduleReview, type ReviewGrade } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recallItems, recallReviews } from "../../db/schema.js";
import {
  getRecallItemRowForUser,
  reviewStateColumns,
  rowToReviewState,
  toRecallItemDto
} from "./recallQueries.js";

// Real infrastructure boundaries (the database client and id generation) are injected so the
// commands stay deterministic and testable; `now` is passed in for the same reason (and feeds the
// pure SM-2 scheduler).
export type RecallDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
}>;

export type RecordReviewResult =
  | Readonly<{ item: RecallItemDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>;

export type SnoozeRecallResult =
  | Readonly<{ item: RecallItemDto; status: "snoozed" }>
  | Readonly<{ status: "not_found" }>;

// How far a snooze defers an item: one day, so it leaves today's batch and reappears tomorrow.
const SNOOZE_DEFER_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Enroll a recall item for a user, seeding its SM-2 review state (due immediately). Provenance and
// gloss are optional; absent means jotted / LLM-supplied.
export async function enrollRecallItem(
  dependencies: RecallDependencies,
  request: EnrollRecallItemRequest,
  userId: string,
  now: Date
): Promise<RecallItemDto> {
  const id = dependencies.createId();
  const review = newReviewState(now);
  const row = {
    chunkId: request.chunkId ?? null,
    createdAt: now,
    gloss: request.gloss ?? null,
    id,
    kind: request.kind,
    provenanceEntryId: request.provenanceEntryId ?? null,
    text: request.text,
    userId,
    ...reviewStateColumns(review)
  };

  await dependencies.db.insert(recallItems).values(row);

  return toRecallItemDto(row);
}

// Record a review of one of the user's items: apply SM-2 (#188), overwrite the item's review state,
// and append a history row — atomically. Returns `not_found` for a missing item or another user's.
export async function recordRecallReview(
  dependencies: RecallDependencies,
  itemId: string,
  grade: ReviewGrade,
  userId: string,
  now: Date
): Promise<RecordReviewResult> {
  const existing = await getRecallItemRowForUser(dependencies.db, itemId, userId);

  if (existing === undefined) {
    return { status: "not_found" };
  }

  const nextState = scheduleReview(rowToReviewState(existing), grade, now);
  const columns = reviewStateColumns(nextState);
  const reviewId = dependencies.createId();

  await dependencies.db.transaction(async (tx) => {
    await tx
      .update(recallItems)
      .set(columns)
      .where(and(eq(recallItems.id, itemId), eq(recallItems.userId, userId)));
    await tx
      .insert(recallReviews)
      .values({ grade, id: reviewId, recallItemId: itemId, reviewedAt: now });
  });

  return { item: toRecallItemDto({ ...existing, ...columns }), status: "recorded" };
}

// Snooze defers an item OUT of today's batch by moving ONLY its `due_at` forward one day. A snooze is
// NOT a grade: ease/interval/repetitions/lapses/lastReviewedAt are left untouched, so the SM-2 schedule
// is unchanged — the item simply drops out of today and reappears tomorrow. Returns `not_found` for a
// missing item or another user's.
export async function snoozeRecallItem(
  db: DbClient,
  userId: string,
  itemId: string,
  now: Date
): Promise<SnoozeRecallResult> {
  const existing = await getRecallItemRowForUser(db, itemId, userId);

  if (existing === undefined) {
    return { status: "not_found" };
  }

  const dueAt = new Date(now.getTime() + SNOOZE_DEFER_DAYS * MS_PER_DAY);

  await db
    .update(recallItems)
    .set({ dueAt })
    .where(and(eq(recallItems.id, itemId), eq(recallItems.userId, userId)));

  return { item: toRecallItemDto({ ...existing, dueAt }), status: "snoozed" };
}
