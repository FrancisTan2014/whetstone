import type {
  DueRecitationPassageDto,
  RecitationCueStrengthDto,
  RecitationPassageDto,
  RecitationReviewRating,
  RecitationSupportLevelDto
} from "@whetstone/contracts";
import {
  applyRating,
  coveredPassageText,
  DEFAULT_RECITATION_SUPPORT_LEVEL,
  mergePassageRanges,
  newReviewState,
  reanchorPassageRange,
  seedPassageRanges,
  splitPassageRange,
  toEntryId,
  type EntryId,
  type PassageRange
} from "@whetstone/domain";
import { and, eq, gt, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, recitationPassages, recitationReviews } from "../../db/schema.js";
import {
  countReviewsByPassage,
  loadBlockTextByIds,
  loadNextDuePassage,
  loadOwnedPassage,
  loadOwnedPlanForPassages,
  loadPlanPassageAtOrder,
  loadPrecedingPassage,
  loadWorkTextBlocks,
  listPassageRowsForPlan,
  passageReviewStateColumns,
  passageRowToReviewState,
  toRecitationPassageDto,
  type RecitationPassageRow
} from "./recitationPassageQueries.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the passage commands stay
// deterministic and testable; the pure segmentation and FSRS logic live in `@whetstone/domain`.
export type RecitationPassageDependencies = Readonly<{
  createEntryId: () => string;
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

export type SeedPassagesResult =
  | Readonly<{ status: "seeded" | "already_seeded"; passages: ReadonlyArray<RecitationPassageDto> }>
  | Readonly<{ status: "wrong_phase" }>
  | Readonly<{ status: "not_found" }>;

export type SplitPassageResultOut =
  | Readonly<{
      status: "split";
      planEntryId: string;
      passages: ReadonlyArray<RecitationPassageDto>;
    }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "not_found" }>;

export type MergePassageResultOut =
  | Readonly<{
      status: "merged";
      planEntryId: string;
      passages: ReadonlyArray<RecitationPassageDto>;
    }>
  | Readonly<{ status: "no_adjacent_passage" }>
  | Readonly<{ status: "not_found" }>;

export type RecordPassageReviewResult =
  | Readonly<{ status: "recorded"; passage: RecitationPassageDto }>
  | Readonly<{ status: "not_found" }>;

function rowToRange(row: RecitationPassageRow): PassageRange {
  return {
    endBlockEntryId: row.endBlockEntryId,
    endOffset: row.endOffset,
    startBlockEntryId: row.startBlockEntryId,
    startOffset: row.startOffset
  };
}

async function dtosWithCounts(
  db: DbClient,
  rows: ReadonlyArray<RecitationPassageRow>
): Promise<ReadonlyArray<RecitationPassageDto>> {
  const counts = await countReviewsByPassage(
    db,
    rows.map((row) => row.entryId)
  );
  return rows.map((row) => toRecitationPassageDto(row, counts.get(row.entryId) ?? 0));
}

// Seed one passage per non-empty source text block of the plan's Work, in source order, each an
// addressable Entry with its own FSRS card due immediately. Idempotent: a plan already divided returns
// its current passages as `already_seeded` (never a second set). Passage practice is the opt-in
// Learning-phase engine, so a plan that is still `familiarizing` (or already on to `maintenance`) is
// rejected as `wrong_phase` — the learner reaches Learning via Today's explicit "Start reciting" (#578).
// Owner-scoped (`not_found` otherwise).
export async function seedRecitationPassages(
  dependencies: RecitationPassageDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<SeedPassagesResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }
  if (owned.phase !== "learning") {
    return { status: "wrong_phase" };
  }

  const existing = await listPassageRowsForPlan(dependencies.db, planEntryId);
  if (existing.length > 0) {
    return { passages: await dtosWithCounts(dependencies.db, existing), status: "already_seeded" };
  }

  const blocks = await loadWorkTextBlocks(dependencies.db, toEntryId(owned.workEntryId));
  const ranges = seedPassageRanges(blocks);
  const blockText = new Map(blocks.map((block) => [block.blockEntryId, block.text] as const));
  const now = dependencies.now();

  const rows: RecitationPassageRow[] = ranges.map((range, index) => ({
    anchorStatus: "anchored",
    contextSnapshot: owned.workTitle,
    createdAt: now,
    entryId: dependencies.createEntryId(),
    orderIndex: index,
    planEntryId,
    // Each seed range spans a block just loaded into `blockText`, so the covered text is always present.
    sourceText: coveredPassageText(range, blockText)!,
    supportLevel: DEFAULT_RECITATION_SUPPORT_LEVEL,
    ...range,
    ...passageReviewStateColumns(newReviewState(now))
  }));

  await dependencies.db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.insert(entries).values({ id: row.entryId, type: "recitation_passage" });
      await tx.insert(recitationPassages).values(row);
    }
  });

  return { passages: rows.map((row) => toRecitationPassageDto(row, 0)), status: "seeded" };
}

// The plan's passages, in reciting order, with each one's review count. Owner-scoped (`not_found`).
export async function listRecitationPassages(
  dependencies: RecitationPassageDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<
  | Readonly<{ status: "loaded"; passages: ReadonlyArray<RecitationPassageDto> }>
  | Readonly<{ status: "not_found" }>
> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }
  const rows = await listPassageRowsForPlan(dependencies.db, planEntryId);
  return { passages: await dtosWithCounts(dependencies.db, rows), status: "loaded" };
}

function newPassageRow(
  dependencies: RecitationPassageDependencies,
  planEntryId: string,
  contextSnapshot: string,
  range: PassageRange,
  sourceText: string,
  orderIndex: number,
  now: Date
): RecitationPassageRow {
  return {
    anchorStatus: "anchored",
    contextSnapshot,
    createdAt: now,
    entryId: dependencies.createEntryId(),
    orderIndex,
    planEntryId,
    sourceText,
    supportLevel: DEFAULT_RECITATION_SUPPORT_LEVEL,
    ...range,
    ...passageReviewStateColumns(newReviewState(now))
  };
}

// Split a passage at a text position into two contiguous passages, editing boundaries only — the Work
// text never changes. Both halves become fresh passages (new Entries, FSRS reset, prior review history of
// the split passage dropped since its boundaries changed). Rejects a split outside the passage or on a
// boundary (`invalid`). Owner-scoped (`not_found`).
export async function splitRecitationPassage(
  dependencies: RecitationPassageDependencies,
  passageEntryId: EntryId,
  at: Readonly<{ blockEntryId: string; offset: number }>,
  userId: string
): Promise<SplitPassageResultOut> {
  const owned = await loadOwnedPassage(dependencies.db, passageEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const blocks = await loadWorkTextBlocks(dependencies.db, toEntryId(owned.workEntryId));
  const result = splitPassageRange(blocks, rowToRange(owned.row), at);
  if (result.status === "invalid") {
    return { reason: result.reason, status: "invalid" };
  }

  const blockText = new Map(blocks.map((block) => [block.blockEntryId, block.text] as const));
  const now = dependencies.now();
  const planEntryId = owned.row.planEntryId;
  const at0 = owned.row.orderIndex;
  const first = newPassageRow(
    dependencies,
    planEntryId,
    owned.row.contextSnapshot,
    result.first,
    // Both halves reference blocks `splitPassageRange` verified are in the loaded layout, so the covered
    // text is always present.
    coveredPassageText(result.first, blockText)!,
    at0,
    now
  );
  const second = newPassageRow(
    dependencies,
    planEntryId,
    owned.row.contextSnapshot,
    result.second,
    coveredPassageText(result.second, blockText)!,
    at0 + 1,
    now
  );

  await dependencies.db.transaction(async (tx) => {
    await tx.delete(recitationReviews).where(eq(recitationReviews.passageEntryId, passageEntryId));
    await tx.delete(recitationPassages).where(eq(recitationPassages.entryId, passageEntryId));
    await tx.delete(entries).where(eq(entries.id, passageEntryId));
    // Removing 1 passage and inserting 2 nets +1 slot: shift every later passage up by one, freeing the
    // two consecutive slots the halves take.
    await tx
      .update(recitationPassages)
      .set({ orderIndex: sql`${recitationPassages.orderIndex} + 1` })
      .where(
        and(eq(recitationPassages.planEntryId, planEntryId), gt(recitationPassages.orderIndex, at0))
      );
    await tx.insert(entries).values({ id: first.entryId, type: "recitation_passage" });
    await tx.insert(recitationPassages).values(first);
    await tx.insert(entries).values({ id: second.entryId, type: "recitation_passage" });
    await tx.insert(recitationPassages).values(second);
  });

  const rows = await listPassageRowsForPlan(dependencies.db, toEntryId(planEntryId));
  return { passages: await dtosWithCounts(dependencies.db, rows), planEntryId, status: "split" };
}

// Merge a passage with the next one in reciting order into a single passage, editing boundaries only. The
// merged passage is a fresh Entry (FSRS reset, the two source passages' review history dropped). Returns
// `no_adjacent_passage` when the passage is last. Owner-scoped (`not_found`).
export async function mergeNextRecitationPassage(
  dependencies: RecitationPassageDependencies,
  passageEntryId: EntryId,
  userId: string
): Promise<MergePassageResultOut> {
  const owned = await loadOwnedPassage(dependencies.db, passageEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const planEntryId = owned.row.planEntryId;
  const next = await loadPlanPassageAtOrder(dependencies.db, planEntryId, owned.row.orderIndex + 1);
  if (next === undefined) {
    return { status: "no_adjacent_passage" };
  }

  const result = mergePassageRanges(rowToRange(owned.row), rowToRange(next));

  const blocks = await loadWorkTextBlocks(dependencies.db, toEntryId(owned.workEntryId));
  const blockText = new Map(blocks.map((block) => [block.blockEntryId, block.text] as const));
  const now = dependencies.now();
  const merged = newPassageRow(
    dependencies,
    planEntryId,
    owned.row.contextSnapshot,
    result.range,
    // Unlike seed/split, a merge does not re-validate the range against the live layout: if a source
    // block was removed since anchoring, the covered text is gone and the merged snapshot is empty
    // (the passage then re-anchors to `needs_repair` when next served).
    coveredPassageText(result.range, blockText) ?? "",
    owned.row.orderIndex,
    now
  );

  await dependencies.db.transaction(async (tx) => {
    for (const id of [passageEntryId, next.entryId]) {
      await tx.delete(recitationReviews).where(eq(recitationReviews.passageEntryId, id));
      await tx.delete(recitationPassages).where(eq(recitationPassages.entryId, id));
      await tx.delete(entries).where(eq(entries.id, id));
    }
    // Removing 2 passages and inserting 1 nets -1 slot: close the gap by shifting every passage after the
    // merged pair down by one.
    await tx
      .update(recitationPassages)
      .set({ orderIndex: sql`${recitationPassages.orderIndex} - 1` })
      .where(
        and(
          eq(recitationPassages.planEntryId, planEntryId),
          gt(recitationPassages.orderIndex, next.orderIndex)
        )
      );
    await tx.insert(entries).values({ id: merged.entryId, type: "recitation_passage" });
    await tx.insert(recitationPassages).values(merged);
  });

  const rows = await listPassageRowsForPlan(dependencies.db, toEntryId(planEntryId));
  return { passages: await dtosWithCounts(dependencies.db, rows), planEntryId, status: "merged" };
}

// The user's next due passage, re-anchored against the live Work text before it is served. When the
// source still matches it is served for practice; when it drifted to a new spot in the same block it is
// re-anchored in place; when it can no longer be located it is marked `needs_repair` and the client shows
// a repair prompt instead of practising stale text (#578). Null when nothing is due (no overdue wall).
export async function loadDueRecitationPassage(
  dependencies: RecitationPassageDependencies,
  userId: string
): Promise<DueRecitationPassageDto | null> {
  const now = dependencies.now();
  const due = await loadNextDuePassage(dependencies.db, userId, now);
  if (due === undefined) {
    return null;
  }

  const blockText = await loadBlockTextByIds(dependencies.db, [
    due.row.startBlockEntryId,
    due.row.endBlockEntryId
  ]);
  const outcome = reanchorPassageRange(
    { range: rowToRange(due.row), sourceText: due.row.sourceText },
    blockText
  );

  let anchorStatus: RecitationPassageRow["anchorStatus"];
  const updates: Partial<RecitationPassageRow> = {};
  if (outcome.status === "unchanged") {
    anchorStatus = "anchored";
  } else if (outcome.status === "relocated") {
    anchorStatus = "anchored";
    updates.startOffset = outcome.range.startOffset;
    updates.endOffset = outcome.range.endOffset;
    updates.startBlockEntryId = outcome.range.startBlockEntryId;
    updates.endBlockEntryId = outcome.range.endBlockEntryId;
  } else {
    anchorStatus = "needs_repair";
  }

  if (anchorStatus !== due.row.anchorStatus || Object.keys(updates).length > 0) {
    await dependencies.db
      .update(recitationPassages)
      .set({ ...updates, anchorStatus })
      .where(eq(recitationPassages.entryId, due.row.entryId));
  }

  const preceding = await loadPrecedingPassage(
    dependencies.db,
    due.row.planEntryId,
    due.row.orderIndex
  );
  const precedingText = preceding === undefined ? null : preceding.sourceText;
  const defaultCueStrength: RecitationCueStrengthDto =
    precedingText === null ? "opening" : "preceding_line";

  return {
    anchorStatus,
    context: due.row.contextSnapshot,
    defaultCueStrength,
    passageEntryId: due.row.entryId,
    planEntryId: due.row.planEntryId,
    precedingText,
    supportLevel: due.row.supportLevel,
    targetText: due.row.sourceText,
    workTitle: due.workTitle
  };
}

export type SetPassageSupportLevelResult =
  | Readonly<{ status: "set"; supportLevel: RecitationSupportLevelDto }>
  | Readonly<{ status: "not_found" }>;

// Remember a passage's visual support level (#579). This is a learner preference, not a recall: it never
// applies FSRS and never appends a review row, so viewing or changing the fading leaves the schedule
// untouched. Owner-scoped (`not_found` for a missing, forged, or cross-user passage id).
export async function setRecitationPassageSupportLevel(
  dependencies: RecitationPassageDependencies,
  passageEntryId: EntryId,
  supportLevel: RecitationSupportLevelDto,
  userId: string
): Promise<SetPassageSupportLevelResult> {
  const owned = await loadOwnedPassage(dependencies.db, passageEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  await dependencies.db
    .update(recitationPassages)
    .set({ supportLevel })
    .where(eq(recitationPassages.entryId, passageEntryId));

  return { status: "set", supportLevel };
}

// Record a self-assessment of a passage: apply FSRS (#572), overwrite the passage's card, and append a
// review-history row (rating + the cue strength attempted from) — atomically. Owner-scoped (`not_found`).
// Revealing without rating never calls this, so an un-rated reveal leaves the schedule unchanged.
export async function recordRecitationPassageReview(
  dependencies: RecitationPassageDependencies,
  passageEntryId: EntryId,
  rating: RecitationReviewRating,
  cueStrength: RecitationCueStrengthDto,
  userId: string
): Promise<RecordPassageReviewResult> {
  const owned = await loadOwnedPassage(dependencies.db, passageEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const nextState = applyRating(passageRowToReviewState(owned.row), rating, now);
  const columns = passageReviewStateColumns(nextState);
  const reviewId = dependencies.createId();

  await dependencies.db.transaction(async (tx) => {
    await tx
      .update(recitationPassages)
      .set(columns)
      .where(eq(recitationPassages.entryId, passageEntryId));
    await tx.insert(recitationReviews).values({
      cueStrength,
      id: reviewId,
      passageEntryId,
      rating,
      reviewedAt: now
    });
  });

  const counts = await countReviewsByPassage(dependencies.db, [passageEntryId]);
  return {
    // The review just inserted guarantees a count row for this passage.
    passage: toRecitationPassageDto({ ...owned.row, ...columns }, counts.get(passageEntryId)!),
    status: "recorded"
  };
}
