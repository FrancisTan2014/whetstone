import type {
  RecitationChainDto,
  RecitationChainingDto,
  RecitationReviewRating,
  RecitationTodayDto,
  SessionRecallOutcomeDto,
  WholeWorkStateDto
} from "@whetstone/contracts";
import {
  chainEligibility,
  computeOwnedPrefix,
  isOutcomePassageInSession,
  isUnstartedWholeWorkEligible,
  isWholeWorkOwned,
  passagesToFailFromOutcome,
  RECITATION_REQUEST_RETENTION,
  resolveChainBoundary,
  selectRecitationTodayAction,
  toEntryId,
  type EntryId,
  type ReviewState,
  type SessionRecallOutcome
} from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  entries,
  entryLinks,
  recitationChains,
  recitationPassages,
  recitationWholeWork
} from "../../db/schema.js";
import { applyRatingToCardInTx, seedReviewCard } from "../review/reviewCardCommands.js";
import { type ReviewCardRow } from "../review/reviewCardQueries.js";
import {
  ensurePassageCardInTx,
  selectCardInTx,
  writeCueStrengthEvidence,
  type Transaction
} from "./recitationCardActivation.js";
import { loadOwnedPlanForPassages, loadNextDuePassage } from "./recitationPassageQueries.js";
import {
  loadActiveChainForPlan,
  loadChainPassages,
  loadEarliestActiveChainForUser,
  loadOwnedChain,
  loadPassageMasteries,
  loadWholeWorkForPlan,
  listWholeWorkScanPlansForUser,
  type RecitationChainRow,
  type RecitationWholeWorkRow
} from "./recitationChainingQueries.js";

// The chaining commands need id generation (both a plain id for chains/events and an Entry id for the
// lazily-created whole-work target), the db, and the clock — every scheduling and ownership decision is
// delegated to the pure `@whetstone/domain` logic and the shared review-card substrate, keeping these
// thin and deterministic (#618).
export type RecitationChainingDependencies = Readonly<{
  createEntryId: () => string;
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

async function chainRowToDto(db: DbClient, row: RecitationChainRow): Promise<RecitationChainDto> {
  return {
    chainId: row.id,
    endOrderIndex: row.endOrderIndex,
    passages: [...(await loadChainPassages(db, row.planEntryId, row.endOrderIndex))],
    planEntryId: row.planEntryId,
    status: row.status
  };
}

// Project a whole-work state into its DTO. The schedule now lives in the target's shared review card
// (#618): an unstarted plan has no card and is due only when its phase makes whole-work review eligible;
// a started plan reads its due instant from the card.
function wholeWorkDto(
  row: RecitationWholeWorkRow | undefined,
  unstartedEligible: boolean,
  now: Date
): WholeWorkStateDto {
  if (row === undefined) {
    // Not yet started: it becomes available (due) only when the plan's phase makes whole-work review
    // eligible — the whole Work owned in Learning, or ≥1 anchored passage in Maintenance (#605).
    return { due: unstartedEligible, dueAt: null, exists: false };
  }
  // Once started the aggregate prompt runs on its own FSRS schedule, independent of later passage decay.
  return {
    due: row.card.dueAt.getTime() <= now.getTime(),
    dueAt: row.card.dueAt.toISOString(),
    exists: true
  };
}

// Project a freshly-applied review state into the whole-work DTO (the rating just moved the aggregate
// card, so it exists and is due exactly when its next instant is not in the future).
function ratedWholeWorkDto(state: ReviewState, now: Date): WholeWorkStateDto {
  return {
    due: new Date(state.due).getTime() <= now.getTime(),
    dueAt: state.due,
    exists: true
  };
}

export type LoadChainingResult =
  | Readonly<{ status: "loaded"; chaining: RecitationChainingDto }>
  | Readonly<{ status: "not_found" }>;

// The full chaining progress for one plan, computed at request time (never persisted as an Entry): the
// contiguous owned prefix, whether a chain may be offered and how far, the active chain if any, and the
// whole-work maintenance state. Owner-scoped (`not_found` for a missing, forged, or cross-user plan id).
export async function loadRecitationChaining(
  dependencies: RecitationChainingDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<LoadChainingResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const masteries = await loadPassageMasteries(dependencies.db, planEntryId);
  const activeChain = await loadActiveChainForPlan(dependencies.db, planEntryId);
  const wholeWorkRow = await loadWholeWorkForPlan(dependencies.db, planEntryId);
  const wholeWorkOwned = isWholeWorkOwned(masteries, now);
  const unstartedEligible = isUnstartedWholeWorkEligible(owned.phase, masteries, now);

  return {
    chaining: {
      activeChain:
        activeChain === undefined ? null : await chainRowToDto(dependencies.db, activeChain),
      chainEligibility: chainEligibility(masteries, now),
      ownedPrefix: computeOwnedPrefix(masteries, now),
      planEntryId,
      wholeWork: wholeWorkDto(wholeWorkRow, unstartedEligible, now),
      wholeWorkOwned
    },
    status: "loaded"
  };
}

export type StartChainResult =
  | Readonly<{ status: "started"; chain: RecitationChainDto }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "not_found" }>;

// Start a contiguous chain session ending at the chosen 0-based passage index. The boundary is validated
// against the live owned prefix (`resolveChainBoundary`): it must yield at least two passages, sit inside
// the Work, and reach no further than the owned prefix. At most one chain is active per plan, so any
// prior active chain is replaced. Owner-scoped (`not_found`).
export async function startRecitationChain(
  dependencies: RecitationChainingDependencies,
  planEntryId: EntryId,
  endOrderIndex: number,
  userId: string
): Promise<StartChainResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const masteries = await loadPassageMasteries(dependencies.db, planEntryId);
  const boundary = resolveChainBoundary(masteries, now, endOrderIndex);
  if (boundary.status === "invalid") {
    return { reason: boundary.reason, status: "invalid" };
  }

  const chainId = dependencies.createId();
  await dependencies.db.transaction(async (tx) => {
    await tx
      .delete(recitationChains)
      .where(
        and(eq(recitationChains.planEntryId, planEntryId), eq(recitationChains.status, "active"))
      );
    await tx.insert(recitationChains).values({
      completedAt: null,
      createdAt: now,
      endOrderIndex,
      id: chainId,
      planEntryId,
      status: "active"
    });
  });

  const [row] = await dependencies.db
    .select()
    .from(recitationChains)
    .where(eq(recitationChains.id, chainId))
    .limit(1);
  // The row was just inserted in the same request, so it is always present.
  return { chain: await chainRowToDto(dependencies.db, row!), status: "started" };
}

// Apply a targeted Again to a single passage inside a transaction, through the shared review-card
// substrate: rate its card `again`, appending the review event and its `preceding_line` cue-strength
// evidence (#618). The caller always passes an id drawn from the session's own passages (a chain's
// rendered sequence or the plan's full passage set), so the row is present. A queued (maintenance)
// passage identified as the break is activated first (introduced + card seeded): the whole-work break is
// exactly the moment such a passage needs targeted practice (#605).
async function applyTargetedAgain(
  tx: Transaction,
  dependencies: RecitationChainingDependencies,
  passageEntryId: string,
  userId: string,
  now: Date
): Promise<void> {
  const [row] = await tx
    .select()
    .from(recitationPassages)
    .where(eq(recitationPassages.entryId, passageEntryId))
    .limit(1);
  const card = await ensurePassageCardInTx(tx, row!, userId, now);
  await applyRatingToCardInTx(tx, card, "again", now, dependencies.createId(), (t, eventId) =>
    writeCueStrengthEvidence(t, eventId, "preceding_line")
  );
}

function toDomainOutcome(outcome: SessionRecallOutcomeDto): SessionRecallOutcome {
  return outcome.status === "held"
    ? { status: "held" }
    : { passageEntryId: outcome.passageEntryId, status: "broke" };
}

export type CompleteChainResult =
  | Readonly<{ status: "completed"; chain: RecitationChainDto }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "not_active" }>
  | Readonly<{ status: "not_found" }>;

// Complete an active chain, applying the targeted-lapse rule: a clean run (`held`) rates nothing; a
// `broke` outcome applies an Again to exactly the identified passage and nothing else. The identified
// passage must belong to this chain's rendered sequence, else the request is `invalid`. Owner-scoped
// (`not_found`); a chain that is already completed is `not_active`.
export async function completeRecitationChain(
  dependencies: RecitationChainingDependencies,
  chainId: string,
  outcome: SessionRecallOutcomeDto,
  userId: string
): Promise<CompleteChainResult> {
  const chain = await loadOwnedChain(dependencies.db, chainId, userId);
  if (chain === undefined) {
    return { status: "not_found" };
  }
  if (chain.status !== "active") {
    return { status: "not_active" };
  }

  const domainOutcome = toDomainOutcome(outcome);
  const sessionPassages = await loadChainPassages(
    dependencies.db,
    chain.planEntryId,
    chain.endOrderIndex
  );
  const sessionIds = sessionPassages.map((passage) => passage.passageEntryId);
  if (!isOutcomePassageInSession(domainOutcome, sessionIds)) {
    return { reason: "passage_not_in_session", status: "invalid" };
  }

  const now = dependencies.now();
  await dependencies.db.transaction(async (tx) => {
    for (const passageEntryId of passagesToFailFromOutcome(domainOutcome)) {
      await applyTargetedAgain(tx, dependencies, passageEntryId, userId, now);
    }
    await tx
      .update(recitationChains)
      .set({ completedAt: now, status: "completed" })
      .where(eq(recitationChains.id, chainId));
  });

  const [row] = await dependencies.db
    .select()
    .from(recitationChains)
    .where(eq(recitationChains.id, chainId))
    .limit(1);
  return { chain: await chainRowToDto(dependencies.db, row!), status: "completed" };
}

export type ReviewWholeWorkResult =
  | Readonly<{ status: "reviewed"; wholeWork: WholeWorkStateDto }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "not_eligible" }>
  | Readonly<{ status: "not_found" }>;

// Get-or-create the plan's whole-work target and its shared review card inside the transaction, then
// return the card to rate. On first review the aggregate target Entry (type `recitation_whole_work`) is
// created, linked to its plan by a `contains` entry-link, recorded in `recitation_whole_work`, and seeded
// a fresh 0.95 card (#618). The target carries NO `personal_entries` facet, so it never surfaces on the
// learner's Timeline. On a later review the existing card is read back for rating.
async function ensureWholeWorkCardInTx(
  tx: Transaction,
  dependencies: RecitationChainingDependencies,
  planEntryId: string,
  existing: RecitationWholeWorkRow | undefined,
  userId: string,
  now: Date
): Promise<ReviewCardRow> {
  if (existing !== undefined) {
    return existing.card;
  }
  const targetEntryId = dependencies.createEntryId();
  await tx.insert(entries).values({ id: targetEntryId, type: "recitation_whole_work" });
  await tx
    .insert(recitationWholeWork)
    .values({ createdAt: now, entryId: targetEntryId, planEntryId });
  await tx.insert(entryLinks).values({
    fromEntryId: planEntryId,
    toEntryId: targetEntryId,
    type: "contains"
  });
  await seedReviewCard(tx, {
    targetEntryId,
    userId,
    requestedRetention: RECITATION_REQUEST_RETENTION,
    now
  });
  // Just seeded in this tx, so the card is present.
  return (await selectCardInTx(tx, targetEntryId))!;
}

// Review the whole-work maintenance prompt: apply the aggregate FSRS rating to the plan's separate
// whole-work card (created lazily on first review), and — via the targeted-lapse rule — apply an Again
// to a single identified broken passage without resetting any other. The two FSRS states never merge: a
// whole-work lapse reschedules only the aggregate, and the aggregate rating writes no cue-strength
// evidence (evidence is passage-level only). Eligible while unstarted only when the plan's phase allows
// it (whole Work owned in Learning, or ≥1 anchored passage in Maintenance — #605); afterwards it runs on
// its own schedule. Owner-scoped (`not_found`).
export async function reviewWholeWork(
  dependencies: RecitationChainingDependencies,
  planEntryId: EntryId,
  rating: RecitationReviewRating,
  outcome: SessionRecallOutcomeDto,
  userId: string
): Promise<ReviewWholeWorkResult> {
  const owned = await loadOwnedPlanForPassages(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const masteries = await loadPassageMasteries(dependencies.db, planEntryId);
  const existing = await loadWholeWorkForPlan(dependencies.db, planEntryId);
  if (existing === undefined && !isUnstartedWholeWorkEligible(owned.phase, masteries, now)) {
    return { status: "not_eligible" };
  }

  const domainOutcome = toDomainOutcome(outcome);
  const sessionIds = masteries.map((passage) => passage.passageEntryId);
  if (!isOutcomePassageInSession(domainOutcome, sessionIds)) {
    return { reason: "passage_not_in_session", status: "invalid" };
  }

  const rated = await dependencies.db.transaction(async (tx) => {
    // The aggregate rating and the targeted passage Again land in one transaction so a whole-work review
    // is atomic: either both FSRS states move or neither does.
    const card = await ensureWholeWorkCardInTx(
      tx,
      dependencies,
      planEntryId,
      existing,
      userId,
      now
    );
    const applied = await applyRatingToCardInTx(tx, card!, rating, now, dependencies.createId());
    for (const passageEntryId of passagesToFailFromOutcome(domainOutcome)) {
      await applyTargetedAgain(tx, dependencies, passageEntryId, userId, now);
    }
    return applied.state;
  });

  return { status: "reviewed", wholeWork: ratedWholeWorkDto(rated, now) };
}

// Today's single recitation action across all the learner's plans, chosen by the fixed domain priority
// (`selectRecitationTodayAction`): a due passage, else an active chain, else a whole-work prompt, else
// none. At most one action ever surfaces, so recitation never becomes an overdue wall.
export async function loadRecitationToday(
  dependencies: RecitationChainingDependencies,
  userId: string
): Promise<RecitationTodayDto> {
  const now = dependencies.now();
  const duePassage = await loadNextDuePassage(dependencies.db, userId, now);
  const activeChain = await loadEarliestActiveChainForUser(dependencies.db, userId);

  // Scan every plan (Learning and Maintenance) for the first whose whole-work prompt is due — owned but
  // unstarted / phase-eligible, or a started card past its due instant. Deterministic order and the
  // per-plan phase come from `listWholeWorkScanPlansForUser` (#605).
  let wholeWorkPlan: Readonly<{ planEntryId: string; workTitle: string }> | undefined;
  for (const plan of await listWholeWorkScanPlansForUser(dependencies.db, userId)) {
    const masteries = await loadPassageMasteries(dependencies.db, toEntryId(plan.planEntryId));
    const row = await loadWholeWorkForPlan(dependencies.db, plan.planEntryId);
    if (wholeWorkDto(row, isUnstartedWholeWorkEligible(plan.phase, masteries, now), now).due) {
      wholeWorkPlan = plan;
      break;
    }
  }

  const action = selectRecitationTodayAction({
    hasActiveChain: activeChain !== undefined,
    hasDuePassage: duePassage !== undefined,
    wholeWorkDue: wholeWorkPlan !== undefined
  });

  // `action` is derived from exactly these three booleans, so the matching candidate is always present.
  if (action === "due_passage") {
    return {
      action,
      activeChain: null,
      planEntryId: duePassage!.row.planEntryId,
      workTitle: duePassage!.workTitle
    };
  }
  if (action === "chain") {
    return {
      action,
      activeChain: await chainRowToDto(dependencies.db, activeChain!.row),
      planEntryId: activeChain!.row.planEntryId,
      workTitle: activeChain!.workTitle
    };
  }
  if (action === "whole_work") {
    return {
      action,
      activeChain: null,
      planEntryId: wholeWorkPlan!.planEntryId,
      workTitle: wholeWorkPlan!.workTitle
    };
  }
  return { action: "none", activeChain: null, planEntryId: null, workTitle: null };
}
