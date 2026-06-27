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
