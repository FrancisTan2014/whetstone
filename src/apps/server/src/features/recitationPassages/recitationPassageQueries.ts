import type { RecitationPassageDto } from "@whetstone/contracts";
import type { EntryId, ReviewState } from "@whetstone/domain";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  docBlocks,
  personalEntries,
  readingUnits,
  recitationPassages,
  recitationPlans,
  recitationReviews,
  workMeta
} from "../../db/schema.js";

// One persisted passage row.
export type RecitationPassageRow = typeof recitationPassages.$inferSelect;

// The inlined FSRS card columns shared by every table that schedules with `@whetstone/domain`
// (`recitation_passages`, `recitation_whole_work`): a structural subset so one pair of mappers converts
// any such row to/from a domain `ReviewState`.
export type InlineFsrsCard = Pick<
  RecitationPassageRow,
  | "difficulty"
  | "dueAt"
  | "elapsedDays"
  | "lapses"
  | "lastReviewedAt"
  | "learningSteps"
  | "reps"
  | "scheduledDays"
  | "stability"
  | "state"
>;

// A passage (or plan) resolved together with the source Work it belongs to, for the review context.
export type OwnedPassage = Readonly<{
  row: RecitationPassageRow;
  workEntryId: string;
  workTitle: string;
}>;

// Reconstruct the domain ReviewState from an inlined FSRS card (timestamps -> ISO; null last-reviewed
// preserved), so a recorded review is scheduled by `@whetstone/domain` exactly as recall items are.
export function passageRowToReviewState(row: InlineFsrsCard): ReviewState {
  return {
    due: row.dueAt.toISOString(),
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    lapses: row.lapses,
    lastReviewedAt: row.lastReviewedAt === null ? null : row.lastReviewedAt.toISOString(),
    learningSteps: row.learningSteps,
    reps: row.reps,
    scheduledDays: row.scheduledDays,
    stability: row.stability,
    state: row.state
  };
}

// Map a ReviewState onto the inlined FSRS columns (ISO -> Date) for insert/update.
export function passageReviewStateColumns(state: ReviewState): InlineFsrsCard {
  return {
    difficulty: state.difficulty,
    dueAt: new Date(state.due),
    elapsedDays: state.elapsedDays,
    lapses: state.lapses,
    lastReviewedAt: state.lastReviewedAt === null ? null : new Date(state.lastReviewedAt),
    learningSteps: state.learningSteps,
    reps: state.reps,
    scheduledDays: state.scheduledDays,
    stability: state.stability,
    state: state.state
  };
}

export function toRecitationPassageDto(
  row: RecitationPassageRow,
  reviewCount: number
): RecitationPassageDto {
  return {
    anchorStatus: row.anchorStatus,
    dueAt: row.dueAt.toISOString(),
    endBlockEntryId: row.endBlockEntryId,
    endOffset: row.endOffset,
    entryId: row.entryId,
    lapses: row.lapses,
    lastReviewedAt: row.lastReviewedAt === null ? null : row.lastReviewedAt.toISOString(),
    orderIndex: row.orderIndex,
    planEntryId: row.planEntryId,
    reps: row.reps,
    reviewCount,
    sourceText: row.sourceText,
    startBlockEntryId: row.startBlockEntryId,
    startOffset: row.startOffset
  };
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

// One passage scoped to its owner (through its plan's `personal_entries` facet), with the plan's Work;
// undefined for a missing, forged, or cross-user passage id.
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

  return row === undefined
    ? undefined
    : { row: row.passage, workEntryId: row.workEntryId, workTitle: row.workTitle };
}

// The recorded-review count for each of the given passages, as a map keyed by passage id (absent = 0).
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
      passageEntryId: recitationReviews.passageEntryId
    })
    .from(recitationReviews)
    .where(inArray(recitationReviews.passageEntryId, [...passageEntryIds]))
    .groupBy(recitationReviews.passageEntryId);

  return new Map(rows.map((row) => [row.passageEntryId, row.count]));
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

// The user's single next-due passage across all their recitation plans (due_at <= now), soonest first,
// with the Work it belongs to; undefined when nothing is due (Today then shows no overdue wall). Only
// `learning`-phase plans surface here: passage practice is the Learning-phase engine, so a plan moved on
// to `maintenance` (or never started) never enters the due queue (#578).
export async function loadNextDuePassage(
  db: DbClient,
  userId: string,
  now: Date
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
    .where(
      and(
        eq(personalEntries.userId, userId),
        eq(recitationPlans.phase, "learning"),
        lte(recitationPassages.dueAt, now)
      )
    )
    .orderBy(
      asc(recitationPassages.dueAt),
      asc(recitationPassages.orderIndex),
      asc(recitationPassages.entryId)
    )
    .limit(1);

  return row === undefined
    ? undefined
    : { row: row.passage, workEntryId: row.workEntryId, workTitle: row.workTitle };
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
