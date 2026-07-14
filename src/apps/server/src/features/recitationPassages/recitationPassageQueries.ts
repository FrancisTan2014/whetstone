import type { RecitationPassageDto } from "@whetstone/contracts";
import {
  evaluateRecitationIntroduction,
  localDayBoundary,
  type EntryId,
  type RecitationIntroductionReason
} from "@whetstone/domain";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  docBlocks,
  personalEntries,
  readingUnits,
  recitationPassages,
  recitationPlans,
  reviewCards,
  reviewEvents,
  workMeta
} from "../../db/schema.js";
import { type ReviewCardRow } from "../review/reviewCardQueries.js";

// One persisted passage row.
export type RecitationPassageRow = typeof recitationPassages.$inferSelect;

// A passage (or plan) resolved together with the source Work it belongs to and its shared review card
// (null when the passage is still queued), for the review context.
export type OwnedPassage = Readonly<{
  row: RecitationPassageRow;
  card: ReviewCardRow | null;
  workEntryId: string;
  workTitle: string;
}>;

// Project a passage into its DTO. Scheduling truth now lives in the passage's shared review card (#618):
// an active passage (introduced_at non-null) has a card and exposes its due/reps/lapses/last-reviewed;
// a queued passage has no card and is reported as `queued`. The DTO shape is unchanged from #605.
export function toRecitationPassageDto(
  row: RecitationPassageRow,
  card: ReviewCardRow | null,
  reviewCount: number
): RecitationPassageDto {
  const base = {
    anchorStatus: row.anchorStatus,
    endBlockEntryId: row.endBlockEntryId,
    endOffset: row.endOffset,
    entryId: row.entryId,
    orderIndex: row.orderIndex,
    planEntryId: row.planEntryId,
    reviewCount,
    sourceText: row.sourceText,
    startBlockEntryId: row.startBlockEntryId,
    startOffset: row.startOffset
  } as const;
  if (row.introducedAt === null || card === null) {
    return { ...base, status: "queued" };
  }
  return {
    ...base,
    dueAt: card.dueAt.toISOString(),
    lapses: card.lapses,
    lastReviewedAt: card.lastReviewedAt === null ? null : card.lastReviewedAt.toISOString(),
    reps: card.reps,
    status: "active"
  };
}

// The shared review cards for a set of passage (target) Entry ids, as a map keyed by target id (absent =
// queued passage with no card). One JOIN-free lookup so a list of passages can be projected without a
// per-row query.
export async function loadReviewCardsForTargets(
  db: DbClient,
  targetEntryIds: readonly string[]
): Promise<Map<string, ReviewCardRow>> {
  if (targetEntryIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select()
    .from(reviewCards)
    .where(inArray(reviewCards.targetEntryId, [...targetEntryIds]));
  return new Map(rows.map((row) => [row.targetEntryId, row]));
}

// The user's ownership of a plan (via its `personal_entries` facet) plus the source Work it links to and
// the plan's phase; undefined when the plan does not exist or belongs to another user. The scope every
// passage mutation and read checks so a forged or cross-user plan id is a 404, and the phase the
// segmentation gate reads so passage practice stays the opt-in Learning-phase engine (#578).
export async function loadOwnedPlanForPassages(
  db: DbClient,
  planEntryId: EntryId,
  userId: string
): Promise<
  | Readonly<{
      phase: typeof recitationPlans.$inferSelect.phase;
      workEntryId: string;
      workTitle: string;
    }>
  | undefined
> {
  const [row] = await db
    .select({
      phase: recitationPlans.phase,
      workEntryId: recitationPlans.workEntryId,
      workTitle: workMeta.title
    })
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(and(eq(recitationPlans.entryId, planEntryId), eq(personalEntries.userId, userId)))
    .limit(1);

  return row;
}

// One passage scoped to its owner (through its plan's `personal_entries` facet), with the plan's Work and
// the passage's shared review card (null when queued); undefined for a missing, forged, or cross-user
// passage id.
export async function loadOwnedPassage(
  db: DbClient,
  passageEntryId: EntryId,
  userId: string
): Promise<OwnedPassage | undefined> {
  const [row] = await db
    .select({
      passage: recitationPassages,
      workEntryId: recitationPlans.workEntryId,
      workTitle: workMeta.title
    })
    .from(recitationPassages)
    .innerJoin(recitationPlans, eq(recitationPlans.entryId, recitationPassages.planEntryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(and(eq(recitationPassages.entryId, passageEntryId), eq(personalEntries.userId, userId)))
    .limit(1);

  if (row === undefined) {
    return undefined;
  }
  const cards = await loadReviewCardsForTargets(db, [row.passage.entryId]);
  return {
    row: row.passage,
    card: cards.get(row.passage.entryId) ?? null,
    workEntryId: row.workEntryId,
    workTitle: row.workTitle
  };
}

// The recorded-review count for each of the given passages, as a map keyed by passage id (absent = 0).
// A passage's practice history is now the append-only `review_events` (`rating` events) keyed by its
// target Entry id (#618).
export async function countReviewsByPassage(
  db: DbClient,
  passageEntryIds: readonly string[]
): Promise<Map<string, number>> {
  if (passageEntryIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      targetEntryId: reviewEvents.targetEntryId
    })
    .from(reviewEvents)
    .where(
      and(
        inArray(reviewEvents.targetEntryId, [...passageEntryIds]),
        eq(reviewEvents.type, "rating")
      )
    )
    .groupBy(reviewEvents.targetEntryId);

  return new Map(rows.map((row) => [row.targetEntryId, row.count]));
}

// Every passage of a plan, in reciting order (orderIndex; id as a stable tie-break).
export async function listPassageRowsForPlan(
  db: DbClient,
  planEntryId: EntryId
): Promise<ReadonlyArray<RecitationPassageRow>> {
  return db
    .select()
    .from(recitationPassages)
    .where(eq(recitationPassages.planEntryId, planEntryId))
    .orderBy(asc(recitationPassages.orderIndex), asc(recitationPassages.entryId));
}

// A preview of the lowest-order queued passage awaiting introduction (#607): just enough to show the
// learner what "New passage" would introduce, without exposing the whole row.
export type RecitationNextQueuedPreview = Readonly<{
  entryId: string;
  orderIndex: number;
  sourceText: string;
}>;

// The server-computed new-passage introduction status for one plan (#607), the single source the
// introduction route and the activate command both read. `dueCount` counts only ACTIVE, introduced
// passages whose shared card is due at/-before `now` — queued passages have no card and never count.
// `introducedToday` counts passages introduced within the learner's LOCAL day (#606), so the cap resets
// at the learner's midnight, not the server's. `nextQueued` is the lowest-order not-yet-introduced
// passage (the ordered rows make the first queued row the next to introduce). Undefined when the plan is
// not owned (the route maps that to 404).
export type RecitationIntroductionStatus = Readonly<{
  anyIntroduced: boolean;
  dailyCap: number;
  dueCount: number;
  introducedToday: number;
  newPassageAvailable: boolean;
  nextQueued: RecitationNextQueuedPreview | null;
  phase: typeof recitationPlans.$inferSelect.phase;
  planEntryId: string;
  reason: RecitationIntroductionReason;
  remainingCapacity: number;
}>;

export async function loadRecitationIntroductionStatus(
  db: DbClient,
  planEntryId: EntryId,
  userId: string,
  now: Date,
  timeZone: string
): Promise<RecitationIntroductionStatus | undefined> {
  const owned = await loadOwnedPlanForPassages(db, planEntryId, userId);
  if (owned === undefined) {
    return undefined;
  }

  const passages = await listPassageRowsForPlan(db, planEntryId);
  const cards = await loadReviewCardsForTargets(
    db,
    passages.map((passage) => passage.entryId)
  );

  const dueCount = passages.filter((passage) => {
    if (passage.introducedAt === null) {
      return false;
    }
    const card = cards.get(passage.entryId);
    return card !== undefined && card.status === "active" && card.dueAt.getTime() <= now.getTime();
  }).length;

  const { utcEnd, utcStart } = localDayBoundary(now, timeZone);
  const introducedToday = passages.filter(
    (passage) =>
      passage.introducedAt !== null &&
      passage.introducedAt.getTime() >= utcStart.getTime() &&
      passage.introducedAt.getTime() < utcEnd.getTime()
  ).length;

  // The rows are ordered by orderIndex, so the first queued row is always the next passage to introduce.
  const nextQueuedRow = passages.find((passage) => passage.introducedAt === null);
  const nextQueued: RecitationNextQueuedPreview | null =
    nextQueuedRow === undefined
      ? null
      : {
          entryId: nextQueuedRow.entryId,
          orderIndex: nextQueuedRow.orderIndex,
          sourceText: nextQueuedRow.sourceText
        };

  const availability = evaluateRecitationIntroduction({
    dueCount,
    hasQueued: nextQueued !== null,
    introducedToday,
    isLearning: owned.phase === "learning"
  });

  return {
    anyIntroduced: passages.some((passage) => passage.introducedAt !== null),
    dailyCap: availability.dailyCap,
    dueCount,
    introducedToday,
    newPassageAvailable: availability.newPassageAvailable,
    nextQueued,
    phase: owned.phase,
    planEntryId,
    reason: availability.reason,
    remainingCapacity: availability.remainingCapacity
  };
}

// The Work's text blocks in true source order (reading-unit order, then block order), as the seed
// material for passage boundaries. `plaintext` is byte-aligned with the reader's rendered text (#344),
// so offsets computed here address the block exactly as note anchors do.
export async function loadWorkTextBlocks(
  db: DbClient,
  workEntryId: EntryId
): Promise<ReadonlyArray<Readonly<{ blockEntryId: string; text: string }>>> {
  return db
    .select({ blockEntryId: docBlocks.id, text: docBlocks.plaintext })
    .from(docBlocks)
    .innerJoin(readingUnits, eq(docBlocks.readingUnitEntryId, readingUnits.entryId))
    .where(eq(docBlocks.workEntryId, workEntryId))
    .orderBy(asc(readingUnits.orderIndex), asc(docBlocks.orderIndex));
}

// The current text of the given blocks as a map keyed by block id (absent = deleted block). Used to
// re-anchor a passage against the live Work text (always the passage's start and end block).
export async function loadBlockTextByIds(
  db: DbClient,
  blockEntryIds: readonly string[]
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: docBlocks.id, text: docBlocks.plaintext })
    .from(docBlocks)
    .where(inArray(docBlocks.id, [...blockEntryIds]));

  return new Map(rows.map((row) => [row.id, row.text]));
}

// The user's single next-due passage across all their recitation plans, soonest first, with the Work it
// belongs to and its shared review card. Only ACTIVE passages (introduced_at set) that own an `active`
// review card due at or before now surface — passage practice is the Learning-phase engine, and a queued
// passage has no card, so a plan on `maintenance` (or a not-yet-activated passage) never enters the due
// queue (#578, #605, #618). Recitation joins its feature target to the shared card through the target
// Entry id — it never reimplements the schedule. Undefined when nothing is due.
export async function loadNextDuePassage(
  db: DbClient,
  userId: string,
  now: Date
): Promise<OwnedPassage | undefined> {
  const [row] = await db
    .select({
      passage: recitationPassages,
      card: reviewCards,
      workEntryId: recitationPlans.workEntryId,
      workTitle: workMeta.title
    })
    .from(recitationPassages)
    .innerJoin(recitationPlans, eq(recitationPlans.entryId, recitationPassages.planEntryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .innerJoin(reviewCards, eq(reviewCards.targetEntryId, recitationPassages.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        eq(recitationPlans.phase, "learning"),
        isNotNull(recitationPassages.introducedAt),
        eq(reviewCards.status, "active"),
        lte(reviewCards.dueAt, now)
      )
    )
    .orderBy(
      asc(reviewCards.dueAt),
      asc(recitationPassages.orderIndex),
      asc(recitationPassages.entryId)
    )
    .limit(1);

  return row === undefined
    ? undefined
    : { row: row.passage, card: row.card, workEntryId: row.workEntryId, workTitle: row.workTitle };
}

// The passage immediately before `orderIndex` in the same plan, or undefined for the first passage —
// its source text is the `preceding_line` cue material for the next passage.
export async function loadPrecedingPassage(
  db: DbClient,
  planEntryId: string,
  orderIndex: number
): Promise<RecitationPassageRow | undefined> {
  if (orderIndex <= 0) {
    return undefined;
  }
  return loadPlanPassageAtOrder(db, planEntryId, orderIndex - 1);
}

// The plan's passage at a specific reciting position, or undefined when there is none (e.g. merging the
// last passage with a non-existent next).
export async function loadPlanPassageAtOrder(
  db: DbClient,
  planEntryId: string,
  orderIndex: number
): Promise<RecitationPassageRow | undefined> {
  const [row] = await db
    .select()
    .from(recitationPassages)
    .where(
      and(
        eq(recitationPassages.planEntryId, planEntryId),
        eq(recitationPassages.orderIndex, orderIndex)
      )
    )
    .limit(1);

  return row;
}
