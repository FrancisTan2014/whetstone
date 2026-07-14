import type { ChainPassageDto } from "@whetstone/contracts";
import type { EntryId, PassageMastery } from "@whetstone/domain";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  personalEntries,
  recitationChains,
  recitationPassages,
  recitationPlans,
  recitationReviews,
  recitationWholeWork,
  workMeta
} from "../../db/schema.js";
import {
  listPassageRowsForPlan,
  passageRowToReviewStateOrNull
} from "./recitationPassageQueries.js";

export type RecitationChainRow = typeof recitationChains.$inferSelect;
export type RecitationWholeWorkRow = typeof recitationWholeWork.$inferSelect;

// A plan for the Today whole-work scan: its Work title plus the phase, so the scan can apply the
// phase-aware unstarted eligibility rule (Learning needs the whole Work owned; Maintenance needs ≥1
// anchored passage — #605).
export type WholeWorkScanPlan = Readonly<{
  phase: "familiarizing" | "learning" | "maintenance";
  planEntryId: string;
  workTitle: string;
}>;

// The successful-review count (Good/Easy only) for each of the given passages, keyed by passage id
// (absent = 0). Ownership is earned by clean recalls, so a Hard or Again never advances it — unlike the
// raw review count used for progress display.
export async function countSuccessfulReviewsByPassage(
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
    .where(
      and(
        inArray(recitationReviews.passageEntryId, [...passageEntryIds]),
        inArray(recitationReviews.rating, ["good", "easy"])
      )
    )
    .groupBy(recitationReviews.passageEntryId);

  return new Map(rows.map((row) => [row.passageEntryId, row.count]));
}

// Each passage of a plan as a domain `PassageMastery` (id + successful-review count + FSRS state +
// anchor validity), in reciting order — the exact input the pure chaining/ownership logic consumes. A
// queued (maintenance) passage has a null FSRS state; `anchored` reflects whether its range still
// resolves, which whole-work maintenance eligibility depends on (#605).
export async function loadPassageMasteries(
  db: DbClient,
  planEntryId: EntryId
): Promise<ReadonlyArray<PassageMastery>> {
  const rows = await listPassageRowsForPlan(db, planEntryId);
  const successful = await countSuccessfulReviewsByPassage(
    db,
    rows.map((row) => row.entryId)
  );
  return rows.map((row) => ({
    anchored: row.anchorStatus === "anchored",
    passageEntryId: row.entryId,
    state: passageRowToReviewStateOrNull(row),
    successfulReviews: successful.get(row.entryId) ?? 0
  }));
}

// The plan's passages up to and including `endOrderIndex`, in reciting order, as the chain's rendered
// sequence (id + position + source text). The learner reads these to spot where recall broke.
export async function loadChainPassages(
  db: DbClient,
  planEntryId: string,
  endOrderIndex: number
): Promise<ReadonlyArray<ChainPassageDto>> {
  const rows = await db
    .select({
      orderIndex: recitationPassages.orderIndex,
      passageEntryId: recitationPassages.entryId,
      sourceText: recitationPassages.sourceText
    })
    .from(recitationPassages)
    .where(
      and(
        eq(recitationPassages.planEntryId, planEntryId),
        lte(recitationPassages.orderIndex, endOrderIndex)
      )
    )
    .orderBy(asc(recitationPassages.orderIndex), asc(recitationPassages.entryId));
  return rows;
}

// The plan's single `active` chain, or undefined when none is open. At most one is active at a time
// (enforced by the command layer replacing any prior active chain when a new one starts).
export async function loadActiveChainForPlan(
  db: DbClient,
  planEntryId: string
): Promise<RecitationChainRow | undefined> {
  const [row] = await db
    .select()
    .from(recitationChains)
    .where(
      and(eq(recitationChains.planEntryId, planEntryId), eq(recitationChains.status, "active"))
    )
    .orderBy(asc(recitationChains.createdAt))
    .limit(1);
  return row;
}

// A chain scoped to its owner (through its plan's `personal_entries` facet); undefined for a missing,
// forged, or cross-user chain id — so a completion request can never touch another learner's chain.
export async function loadOwnedChain(
  db: DbClient,
  chainId: string,
  userId: string
): Promise<RecitationChainRow | undefined> {
  const [row] = await db
    .select({ chain: recitationChains })
    .from(recitationChains)
    .innerJoin(recitationPlans, eq(recitationPlans.entryId, recitationChains.planEntryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .where(and(eq(recitationChains.id, chainId), eq(personalEntries.userId, userId)))
    .limit(1);
  return row?.chain;
}

// The plan's whole-work aggregate FSRS row, or undefined until the learner first reviews it.
export async function loadWholeWorkForPlan(
  db: DbClient,
  planEntryId: string
): Promise<RecitationWholeWorkRow | undefined> {
  const [row] = await db
    .select()
    .from(recitationWholeWork)
    .where(eq(recitationWholeWork.planEntryId, planEntryId))
    .limit(1);
  return row;
}

// The user's earliest-opened active chain across all their plans, with the Work title, for Today's
// bounded selection; undefined when no chain is open. Oldest first so a long-running chain is finished
// before a newer one is surfaced.
export async function loadEarliestActiveChainForUser(
  db: DbClient,
  userId: string
): Promise<Readonly<{ row: RecitationChainRow; workTitle: string }> | undefined> {
  const [row] = await db
    .select({ chain: recitationChains, workTitle: workMeta.title })
    .from(recitationChains)
    .innerJoin(recitationPlans, eq(recitationPlans.entryId, recitationChains.planEntryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(and(eq(personalEntries.userId, userId), eq(recitationChains.status, "active")))
    .orderBy(asc(recitationChains.createdAt), asc(recitationChains.id))
    .limit(1);
  return row === undefined ? undefined : { row: row.chain, workTitle: row.workTitle };
}

// The user's plans eligible for a whole-work maintenance prompt — both `learning` and `maintenance`
// phases (a `familiarizing` plan has no passages yet) — with their Work titles and phase, in a stable
// order (title, then id), so Today can scan them for whole-work eligibility deterministically (#605).
export async function listWholeWorkScanPlansForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<WholeWorkScanPlan>> {
  return db
    .select({
      phase: recitationPlans.phase,
      planEntryId: recitationPlans.entryId,
      workTitle: workMeta.title
    })
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        inArray(recitationPlans.phase, ["learning", "maintenance"])
      )
    )
    .orderBy(asc(workMeta.title), asc(recitationPlans.entryId));
}
