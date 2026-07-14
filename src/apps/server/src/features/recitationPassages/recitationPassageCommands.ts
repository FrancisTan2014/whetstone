import type {
  DueRecitationPassageDto,
  RecitationCueStrengthDto,
  RecitationPassageDto,
  RecitationReviewRating,
  RecitationSupportLevelDto
} from "@whetstone/contracts";
import {
  coveredPassageText,
  DEFAULT_RECITATION_SUPPORT_LEVEL,
  localDayBoundary,
  mergePassageRanges,
  reanchorPassageRange,
  RECITATION_DAILY_INTRODUCTION_CAP,
  RECITATION_REQUEST_RETENTION,
  seedPassageRanges,
  splitPassageRange,
  toEntryId,
  type EntryId,
  type PassageRange,
  type RecitationIntroductionReason
} from "@whetstone/domain";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, recitationPassages, reviewCards } from "../../db/schema.js";
import { applyRatingToCardInTx, seedReviewCard } from "../review/reviewCardCommands.js";
import {
  ensurePassageCardInTx,
  writeCueStrengthEvidence,
  type Transaction
} from "./recitationCardActivation.js";
import {
  countReviewsByPassage,
  loadBlockTextByIds,
  loadNextDuePassage,
  loadOwnedPassage,
  loadOwnedPlanForPassages,
  loadPlanPassageAtOrder,
  loadPrecedingPassage,
  loadRecitationIntroductionStatus,
  loadReviewCardsForTargets,
  loadWorkTextBlocks,
  listPassageRowsForPlan,
  toRecitationPassageDto,
  type OwnedPassage,
  type RecitationIntroductionStatus,
  type RecitationPassageRow
} from "./recitationPassageQueries.js";
import { deleteRecitationReviewData } from "./recitationReviewData.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the passage commands stay
// deterministic and testable; the pure segmentation logic lives in `@whetstone/domain` and all FSRS
// scheduling goes through the shared review-card substrate (#618).
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

export type ActivateNextPassageResult =
  | Readonly<{
      status: "activated";
      passage: RecitationPassageDto;
      introduction: RecitationIntroductionStatus;
    }>
  | Readonly<{ status: "unavailable"; reason: RecitationIntroductionReason }>
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
  const ids = rows.map((row) => row.entryId);
  const counts = await countReviewsByPassage(db, ids);
  const cards = await loadReviewCardsForTargets(db, ids);
  return rows.map((row) =>
    toRecitationPassageDto(row, cards.get(row.entryId) ?? null, counts.get(row.entryId) ?? 0)
  );
}

// Seed one passage per non-empty source text block of the plan's Work, in source order, each an
// addressable Entry. Every passage seeds QUEUED (introduced_at null, no review card, no due work) in BOTH
// `learning` and `maintenance` (#607): Learning introduction is now explicit and paced — the learner
// introduces the first passage with "Start first passage" and each next one deliberately, so seeding
// never hands out an accidental backlog of due items. Idempotent: a plan already divided returns its
// current passages as `already_seeded`. A plan still `familiarizing` is `wrong_phase`. Owner-scoped
// (`not_found` otherwise).
export async function seedRecitationPassages(
  dependencies: RecitationPassageDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<SeedPassagesResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }
  if (owned.phase === "familiarizing") {
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
    introducedAt: null,
    orderIndex: index,
    planEntryId,
    // Each seed range spans a block just loaded into `blockText`, so the covered text is always present.
    sourceText: coveredPassageText(range, blockText)!,
    supportLevel: DEFAULT_RECITATION_SUPPORT_LEVEL,
    ...range
  }));

  await dependencies.db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.insert(entries).values({ id: row.entryId, type: "recitation_passage" });
      await tx.insert(recitationPassages).values(row);
    }
  });

  return { passages: await dtosWithCounts(dependencies.db, rows), status: "seeded" };
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

// The introduction status for a plan (#607): the paced new-passage decision the introduction route
// serves. A thin owner-scoped wrapper over the query, so the route stays trivial. `undefined` (404) for a
// plan the user does not own.
export async function loadRecitationIntroductionStatusForPlan(
  dependencies: RecitationPassageDependencies,
  planEntryId: EntryId,
  userId: string,
  timeZone: string
): Promise<RecitationIntroductionStatus | undefined> {
  return loadRecitationIntroductionStatus(
    dependencies.db,
    planEntryId,
    userId,
    dependencies.now(),
    timeZone
  );
}

// The introduced passages that are currently due at `now` (active card due at/-before now). Queued
// passages have no card and never count, so this is the "no due work" gate for introducing another.
function countDuePassages(
  passages: ReadonlyArray<RecitationPassageRow>,
  cards: Map<string, { status: string; dueAt: Date }>,
  now: Date
): number {
  return passages.filter((passage) => {
    if (passage.introducedAt === null) {
      return false;
    }
    const card = cards.get(passage.entryId);
    return card !== undefined && card.status === "active" && card.dueAt.getTime() <= now.getTime();
  }).length;
}

// Introduce the next queued passage of a Learning plan (#607): the explicit, paced "Start first passage"
// / "New passage" action. The read-check-write is one transaction that locks the plan's passages
// (`FOR UPDATE`) so two concurrent submits serialize — the second sees the first's freshly-introduced
// passage as due work and is rejected, so introduction can never skip order, exceed the daily cap, or
// create a duplicate card. Activating stamps `introduced_at` and seeds ONE active review card at the 0.95
// recitation retention through the shared scheduler boundary. The LOWEST-order queued passage is always
// the one introduced (the ordered rows never skip). Gates in fixed order (not_learning → due_work_remains
// → all_introduced → cap_reached) matching the domain evaluator / status endpoint, via the learner's LOCAL
// day for the cap (#606). Owner-scoped
// (`not_found`).
export async function activateNextRecitationPassage(
  dependencies: RecitationPassageDependencies,
  planEntryId: EntryId,
  userId: string,
  timeZone: string
): Promise<ActivateNextPassageResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const outcome = await dependencies.db.transaction(
    async (
      tx
    ): Promise<
      | Readonly<{ status: "activated"; passageEntryId: string }>
      | Readonly<{ status: "unavailable"; reason: RecitationIntroductionReason }>
    > => {
      // Lock the plan's passage rows for the transaction so a concurrent activate on the same plan
      // serializes behind this one and re-reads its introduced passage as due work.
      const passages = await tx
        .select()
        .from(recitationPassages)
        .where(eq(recitationPassages.planEntryId, planEntryId))
        .orderBy(asc(recitationPassages.orderIndex), asc(recitationPassages.entryId))
        .for("update");
      const cardRows =
        passages.length === 0
          ? []
          : await tx
              .select()
              .from(reviewCards)
              .where(
                inArray(
                  reviewCards.targetEntryId,
                  passages.map((passage) => passage.entryId)
                )
              );
      const cards = new Map(cardRows.map((card) => [card.targetEntryId, card] as const));

      if (owned.phase !== "learning") {
        return { reason: "not_learning", status: "unavailable" };
      }
      if (countDuePassages(passages, cards, now) > 0) {
        return { reason: "due_work_remains", status: "unavailable" };
      }
      // Precedence must match the domain evaluator / status endpoint (resolveReason): running out of
      // queued passages is `all_introduced`, checked BEFORE the daily cap, so GET /introduction and
      // POST /introduce-next never disagree when a plan is both fully introduced and at the cap.
      const nextQueued = passages.find((passage) => passage.introducedAt === null);
      if (nextQueued === undefined) {
        return { reason: "all_introduced", status: "unavailable" };
      }
      const { utcEnd, utcStart } = localDayBoundary(now, timeZone);
      const introducedToday = passages.filter(
        (passage) =>
          passage.introducedAt !== null &&
          passage.introducedAt.getTime() >= utcStart.getTime() &&
          passage.introducedAt.getTime() < utcEnd.getTime()
      ).length;
      if (introducedToday >= RECITATION_DAILY_INTRODUCTION_CAP) {
        return { reason: "cap_reached", status: "unavailable" };
      }

      await tx
        .update(recitationPassages)
        .set({ introducedAt: now })
        .where(eq(recitationPassages.entryId, nextQueued.entryId));
      await seedReviewCard(tx, {
        now,
        requestedRetention: RECITATION_REQUEST_RETENTION,
        targetEntryId: nextQueued.entryId,
        userId
      });
      return { passageEntryId: nextQueued.entryId, status: "activated" };
    }
  );

  if (outcome.status === "unavailable") {
    return { reason: outcome.reason, status: "unavailable" };
  }

  const [row] = await listPassageRowsForPlan(dependencies.db, planEntryId).then((rows) =>
    rows.filter((passage) => passage.entryId === outcome.passageEntryId)
  );
  const counts = await countReviewsByPassage(dependencies.db, [outcome.passageEntryId]);
  const cards = await loadReviewCardsForTargets(dependencies.db, [outcome.passageEntryId]);
  const introduction = await loadRecitationIntroductionStatus(
    dependencies.db,
    planEntryId,
    userId,
    now,
    timeZone
  );
  return {
    introduction: introduction!,
    // The row was just introduced with a seeded active card, so both are present.
    passage: toRecitationPassageDto(
      row!,
      cards.get(outcome.passageEntryId)!,
      counts.get(outcome.passageEntryId) ?? 0
    ),
    status: "activated"
  };
}

function newPassageRow(
  dependencies: RecitationPassageDependencies,
  planEntryId: string,
  contextSnapshot: string,
  range: PassageRange,
  sourceText: string,
  orderIndex: number,
  scheduled: boolean,
  now: Date
): RecitationPassageRow {
  return {
    anchorStatus: "anchored",
    contextSnapshot,
    createdAt: now,
    entryId: dependencies.createEntryId(),
    introducedAt: scheduled ? now : null,
    orderIndex,
    planEntryId,
    sourceText,
    supportLevel: DEFAULT_RECITATION_SUPPORT_LEVEL,
    ...range
  };
}

// Persist a fresh passage (its Entry + row) inside the seed/split/merge transaction, seeding a shared
// review card for an active passage (FSRS reset — the fresh boundaries have no earned schedule). A queued
// passage gets no card.
async function insertFreshPassage(
  tx: Transaction,
  row: RecitationPassageRow,
  userId: string,
  now: Date
): Promise<void> {
  await tx.insert(entries).values({ id: row.entryId, type: "recitation_passage" });
  await tx.insert(recitationPassages).values(row);
  if (row.introducedAt !== null) {
    await seedReviewCard(tx, {
      targetEntryId: row.entryId,
      userId,
      requestedRetention: RECITATION_REQUEST_RETENTION,
      now
    });
  }
}

// Split a passage at a text position into two contiguous passages, editing boundaries only — the Work
// text never changes. Both halves become fresh passages (new Entries, FSRS reset via new cards, and the
// split passage's old card + events + evidence dropped since its boundaries changed). Rejects a split
// outside the passage or on a boundary (`invalid`). Owner-scoped (`not_found`).
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
  // Split preserves the source passage's lifecycle: two active halves for a scheduled passage (FSRS
  // reset), two queued halves for a queued (maintenance) passage — never activating a queued passage.
  const scheduled = owned.row.introducedAt !== null;
  const first = newPassageRow(
    dependencies,
    planEntryId,
    owned.row.contextSnapshot,
    result.first,
    // Both halves reference blocks `splitPassageRange` verified are in the loaded layout, so the covered
    // text is always present.
    coveredPassageText(result.first, blockText)!,
    at0,
    scheduled,
    now
  );
  const second = newPassageRow(
    dependencies,
    planEntryId,
    owned.row.contextSnapshot,
    result.second,
    coveredPassageText(result.second, blockText)!,
    at0 + 1,
    scheduled,
    now
  );

  await dependencies.db.transaction(async (tx) => {
    await deleteRecitationReviewData(tx, [passageEntryId]);
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
    await insertFreshPassage(tx, first, userId, now);
    await insertFreshPassage(tx, second, userId, now);
  });

  const rows = await listPassageRowsForPlan(dependencies.db, toEntryId(planEntryId));
  return { passages: await dtosWithCounts(dependencies.db, rows), planEntryId, status: "split" };
}

// Merge a passage with the next one in reciting order into a single passage, editing boundaries only. The
// merged passage is a fresh Entry (FSRS reset, the two source passages' cards + events + evidence
// dropped). Returns `no_adjacent_passage` when the passage is last. Owner-scoped (`not_found`).
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
    // The merged passage keeps the pair's lifecycle: active (FSRS reset) for a scheduled passage, queued
    // for a queued maintenance passage.
    owned.row.introducedAt !== null,
    now
  );

  await dependencies.db.transaction(async (tx) => {
    await deleteRecitationReviewData(tx, [passageEntryId, next.entryId]);
    for (const id of [passageEntryId, next.entryId]) {
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
    await insertFreshPassage(tx, merged, userId, now);
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
  return due === undefined ? null : buildDuePassageDto(dependencies, due);
}

export type LoadDuePassageForPlanResult =
  | Readonly<{ status: "not_found" }>
  | Readonly<{ passage: DueRecitationPassageDto | null; status: "ok" }>;

// The next due passage of ONE plan, scoped so the recitation hub reviews the due passage of the SAME plan
// it projects — never the earliest-due passage of a different plan (#608). Owner-scoped: a missing,
// forged, or cross-user plan id is `not_found` (the route answers 404), matching the sibling plan
// routes; an owned plan with nothing due resolves to `{ status: "ok", passage: null }` (caught up).
export async function loadDueRecitationPassageForPlan(
  dependencies: RecitationPassageDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<LoadDuePassageForPlanResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }
  const now = dependencies.now();
  const due = await loadNextDuePassage(dependencies.db, userId, now, planEntryId);
  return {
    passage: due === undefined ? null : await buildDuePassageDto(dependencies, due),
    status: "ok"
  };
}

// Re-anchor a due passage against the live Work text and project it as the practice DTO (shared by the
// cross-plan and plan-scoped due readers). When the source still matches it is served as-is; when it
// drifted within the same block it is re-anchored in place; when it can no longer be located it is marked
// `needs_repair` so the client shows a repair prompt instead of practising stale text (#578).
async function buildDuePassageDto(
  dependencies: RecitationPassageDependencies,
  due: OwnedPassage
): Promise<DueRecitationPassageDto> {
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

// Record a self-assessment of a passage (#572): apply FSRS through the shared review card, append the
// review event, and write its cue-strength evidence — atomically, in one transaction. Revealing without
// rating never calls this, so an un-rated reveal leaves the schedule unchanged. A queued passage rated
// here is activated first (introduced + card seeded). When the learner practised with the predecessor as
// a lead-in and marks it failed (`leadInFailed`), the immediately-preceding passage also receives an
// Again — the only passage other than the target ever touched, and never on a clean lead-in (#580).
// Owner-scoped (`not_found`).
export async function recordRecitationPassageReview(
  dependencies: RecitationPassageDependencies,
  passageEntryId: EntryId,
  rating: RecitationReviewRating,
  cueStrength: RecitationCueStrengthDto,
  leadInFailed: boolean,
  userId: string
): Promise<RecordPassageReviewResult> {
  const owned = await loadOwnedPassage(dependencies.db, passageEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const preceding = leadInFailed
    ? await loadPrecedingPassage(dependencies.db, owned.row.planEntryId, owned.row.orderIndex)
    : undefined;

  await dependencies.db.transaction(async (tx) => {
    const targetCard = await ensurePassageCardInTx(tx, owned.row, userId, now);
    await applyRatingToCardInTx(
      tx,
      targetCard,
      rating,
      now,
      dependencies.createId(),
      (t, eventId) => writeCueStrengthEvidence(t, eventId, cueStrength)
    );
    // A failed lead-in fails only the immediate predecessor, and only when one exists (never the target
    // twice, never an unmarked passage). The target's own rating above is unaffected.
    if (preceding !== undefined) {
      const precedingCard = await ensurePassageCardInTx(tx, preceding, userId, now);
      await applyRatingToCardInTx(
        tx,
        precedingCard,
        "again",
        now,
        dependencies.createId(),
        (t, id) => writeCueStrengthEvidence(t, id, "preceding_line")
      );
    }
  });

  const counts = await countReviewsByPassage(dependencies.db, [passageEntryId]);
  const cards = await loadReviewCardsForTargets(dependencies.db, [passageEntryId]);
  return {
    // The review just inserted guarantees a count row and an active card for this passage.
    passage: toRecitationPassageDto(
      { ...owned.row, introducedAt: owned.row.introducedAt ?? now },
      cards.get(passageEntryId)!,
      counts.get(passageEntryId)!
    ),
    status: "recorded"
  };
}
