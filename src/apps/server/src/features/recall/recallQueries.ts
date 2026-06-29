import type { RecallItemDto } from "@whetstone/contracts";
import type { ReviewState } from "@whetstone/domain";
import { and, asc, desc, eq, ilike, lte, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recallItems } from "../../db/schema.js";

// One persisted recall-item row, as selected from the table.
export type RecallItemRow = typeof recallItems.$inferSelect;

// Reconstruct the domain ReviewState from a row (timestamps -> ISO; null last-reviewed preserved),
// so a recorded review can be scheduled by `@whetstone/domain`.
export function rowToReviewState(row: RecallItemRow): ReviewState {
  return {
    dueAt: row.dueAt.toISOString(),
    easeFactor: row.easeFactor,
    intervalDays: row.intervalDays,
    lapses: row.lapses,
    lastReviewedAt: row.lastReviewedAt === null ? null : row.lastReviewedAt.toISOString(),
    repetitions: row.repetitions
  };
}

// Map a ReviewState onto the table's review-state columns (ISO -> Date) for insert/update.
export function reviewStateColumns(
  state: ReviewState
): Pick<
  RecallItemRow,
  "easeFactor" | "intervalDays" | "repetitions" | "lapses" | "lastReviewedAt" | "dueAt"
> {
  return {
    dueAt: new Date(state.dueAt),
    easeFactor: state.easeFactor,
    intervalDays: state.intervalDays,
    lapses: state.lapses,
    lastReviewedAt: state.lastReviewedAt === null ? null : new Date(state.lastReviewedAt),
    repetitions: state.repetitions
  };
}

export function toRecallItemDto(row: RecallItemRow): RecallItemDto {
  return {
    chunkId: row.chunkId,
    createdAt: row.createdAt.toISOString(),
    gloss: row.gloss,
    id: row.id,
    kind: row.kind,
    provenanceEntryId: row.provenanceEntryId,
    review: rowToReviewState(row),
    text: row.text
  };
}

// One recall item scoped to its owner — used to authorize a review against a forged item id or
// another user's item. Returns the raw row (the caller needs its current review state).
export async function getRecallItemRowForUser(
  db: DbClient,
  itemId: string,
  userId: string
): Promise<RecallItemRow | undefined> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.id, itemId), eq(recallItems.userId, userId)))
    .limit(1);

  return rows[0];
}

// One recall item scoped to its owner, as a DTO (the read counterpart used by `get_recall_item`).
export async function getRecallItemForUser(
  db: DbClient,
  itemId: string,
  userId: string
): Promise<RecallItemDto | undefined> {
  const row = await getRecallItemRowForUser(db, itemId, userId);

  return row === undefined ? undefined : toRecallItemDto(row);
}

// The user's recall item linked to a given chunk, if any (newest first). Used by the practice session
// to find-or-enroll the item to schedule for a practised chunk.
export async function getRecallItemByChunkForUser(
  db: DbClient,
  userId: string,
  chunkId: string
): Promise<RecallItemDto | undefined> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), eq(recallItems.chunkId, chunkId)))
    .orderBy(desc(recallItems.createdAt), asc(recallItems.id))
    .limit(1);

  return rows[0] === undefined ? undefined : toRecallItemDto(rows[0]);
}

// The user's most-recent recall item with this exact text, if any. Used to dedupe LLM-supplied items
// (e.g. the bilingual coach's pushed English target, #270) that have no chunk FK to match on, so a
// learner who is pushed the same retry chunk across rounds keeps one recall item, not a pile.
export async function getRecallItemByTextForUser(
  db: DbClient,
  userId: string,
  text: string
): Promise<RecallItemDto | undefined> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), eq(recallItems.text, text)))
    .orderBy(desc(recallItems.createdAt), asc(recallItems.id))
    .limit(1);

  return rows[0] === undefined ? undefined : toRecallItemDto(rows[0]);
}

// The user's items due for review at `now` (due_at <= now), soonest-due first, capped at `limit`.
// Backed by the (user_id, due_at) index.
export async function listDueRecallItems(
  db: DbClient,
  userId: string,
  now: Date,
  limit: number
): Promise<ReadonlyArray<RecallItemDto>> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), lte(recallItems.dueAt, now)))
    .orderBy(asc(recallItems.dueAt), asc(recallItems.id))
    .limit(limit);

  return rows.map(toRecallItemDto);
}

// The user's whole recall set, newest first (id as a stable tiebreak).
export async function listRecallItems(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<RecallItemDto>> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(eq(recallItems.userId, userId))
    .orderBy(desc(recallItems.createdAt), asc(recallItems.id));

  return rows.map(toRecallItemDto);
}

// LIKE metacharacters are escaped so a query is matched literally (a user's `%` is not a wildcard);
// PostgreSQL ILIKE treats backslash as the escape character by default.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// The user's items whose text or gloss contains `query` (case-insensitive), newest first.
export async function searchRecallItems(
  db: DbClient,
  userId: string,
  query: string
): Promise<ReadonlyArray<RecallItemDto>> {
  const pattern = `%${escapeLike(query)}%`;
  const rows = await db
    .select()
    .from(recallItems)
    .where(
      and(
        eq(recallItems.userId, userId),
        or(ilike(recallItems.text, pattern), ilike(recallItems.gloss, pattern))
      )
    )
    .orderBy(desc(recallItems.createdAt), asc(recallItems.id));

  return rows.map(toRecallItemDto);
}
