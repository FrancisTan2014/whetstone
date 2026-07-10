import type { EnrollRecallItemRequest, RecallItemDto, RecallKind } from "@whetstone/contracts";
import { applyRating, newReviewState, type ReviewRating } from "@whetstone/domain";
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
// pure FSRS scheduler).
export type RecallDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  // Offline gloss autofill (#526): resolve a short back for a bare `word`/`phrase` from the bundled
  // offline dictionaries so the reveal step (#525) always has something to retrieve against. Optional
  // because chunk/reading-only feeders (e.g. the session engine) never enroll a glossable kind and so
  // need not wire it; absent means no autofill and `gloss` stays null. Offline-only by construction —
  // enroll never blocks on the network (see `createOfflineGloss`).
  resolveOfflineGloss?: (text: string) => Promise<string | null>;
}>;

// The only kinds a dictionary can honestly gloss. Other kinds (pattern/idiom/proverb/chunk) keep the
// #525 reveal-time floor — no autofill is attempted for them.
const glossableKinds: ReadonlySet<RecallKind> = new Set(["word", "phrase"]);

export type RecordReviewResult =
  | Readonly<{ item: RecallItemDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>;

export type SnoozeRecallResult =
  | Readonly<{ item: RecallItemDto; status: "snoozed" }>
  | Readonly<{ status: "not_found" }>;

// How far a snooze defers an item: one day, so it leaves today's batch and reappears tomorrow.
const SNOOZE_DEFER_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Resolve the gloss (back) to persist for an enroll. A caller-supplied gloss always wins and is never
// overwritten. Only when a `word`/`phrase` arrives with no gloss AND an offline glosser is wired do we
// autofill from the bundled dictionaries (#526); the glosser fails soft to null, so a term the offline
// dictionary does not know enrolls with `gloss` null and never throws — keeping the #525 reveal floor.
async function resolveEnrollGloss(
  dependencies: RecallDependencies,
  request: EnrollRecallItemRequest
): Promise<string | null> {
  const supplied = request.gloss ?? null;
  if (
    supplied !== null ||
    !glossableKinds.has(request.kind) ||
    dependencies.resolveOfflineGloss === undefined
  ) {
    return supplied;
  }

  return dependencies.resolveOfflineGloss(request.text);
}

// Enroll a recall item for a user, seeding its FSRS card state (due immediately). Provenance and
// gloss are optional; absent means jotted / LLM-supplied. `sourceProposalCandidateId` is an INTERNAL
// argument (never taken from the client request): it is set only by the Make Durable save boundary
// (`saveProposalRecallItem`), which first validates the proposal's existence, ownership, and provenance
// match. A raw enroll (jot / reading / speech) passes null.
export async function enrollRecallItem(
  dependencies: RecallDependencies,
  request: EnrollRecallItemRequest,
  userId: string,
  now: Date,
  sourceProposalCandidateId: string | null = null
): Promise<RecallItemDto> {
  const id = dependencies.createId();
  const review = newReviewState(now);
  const gloss = await resolveEnrollGloss(dependencies, request);
  const row = {
    chunkId: request.chunkId ?? null,
    createdAt: now,
    gloss,
    id,
    kind: request.kind,
    provenanceEntryId: request.provenanceEntryId ?? null,
    text: request.text,
    cue: request.cue ?? null,
    useContext: request.useContext ?? null,
    category: request.category ?? null,
    tagsJson: request.tags ?? null,
    sourceProposalCandidateId,
    userId,
    ...reviewStateColumns(review)
  };

  await dependencies.db.insert(recallItems).values(row);

  return toRecallItemDto(row);
}

// Record a review of one of the user's items: apply FSRS (#572), overwrite the item's review state,
// and append a history row — atomically. Returns `not_found` for a missing item or another user's.
export async function recordRecallReview(
  dependencies: RecallDependencies,
  itemId: string,
  rating: ReviewRating,
  userId: string,
  now: Date
): Promise<RecordReviewResult> {
  const existing = await getRecallItemRowForUser(dependencies.db, itemId, userId);

  if (existing === undefined) {
    return { status: "not_found" };
  }

  const nextState = applyRating(rowToReviewState(existing), rating, now);
  const columns = reviewStateColumns(nextState);
  const reviewId = dependencies.createId();

  await dependencies.db.transaction(async (tx) => {
    await tx
      .update(recallItems)
      .set(columns)
      .where(and(eq(recallItems.id, itemId), eq(recallItems.userId, userId)));
    await tx
      .insert(recallReviews)
      .values({ rating, id: reviewId, recallItemId: itemId, reviewedAt: now });
  });

  return { item: toRecallItemDto({ ...existing, ...columns }), status: "recorded" };
}

// Snooze defers an item OUT of today's batch by moving ONLY its `due_at` forward one day. A snooze is
// NOT a rating: the FSRS card state (stability/difficulty/interval/reps/lapses/lastReviewedAt) is left
// untouched, so the schedule is unchanged — the item simply drops out of today and reappears tomorrow.
// Returns `not_found` for a missing item or another user's.
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
