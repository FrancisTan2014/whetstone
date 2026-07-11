import type {
  RecitationChainDto,
  RecitationChainingDto,
  RecitationReviewRating,
  RecitationTodayDto,
  SessionRecallOutcomeDto,
  WholeWorkStateDto
} from "@whetstone/contracts";
import {
  applyRating,
  chainEligibility,
  computeOwnedPrefix,
  isOutcomePassageInSession,
  isWholeWorkOwned,
  newReviewState,
  passagesToFailFromOutcome,
  resolveChainBoundary,
  selectRecitationTodayAction,
  toEntryId,
  type EntryId,
  type SessionRecallOutcome
} from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";

// The transaction handle drizzle passes to a `db.transaction` callback: the same query builder as
// `DbClient`, so a helper can run scoped writes inside an open transaction.
type DbTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

import {
  recitationChains,
  recitationPassages,
  recitationReviews,
  recitationWholeWork
} from "../../db/schema.js";
import {
  loadOwnedPlanForPassages,
  loadNextDuePassage,
  passageReviewStateColumns,
  passageRowToReviewState
} from "./recitationPassageQueries.js";
import {
  loadActiveChainForPlan,
  loadChainPassages,
  loadEarliestActiveChainForUser,
  loadOwnedChain,
  loadPassageMasteries,
  loadWholeWorkForPlan,
  listLearningPlansForUser,
  type RecitationChainRow,
  type RecitationWholeWorkRow
} from "./recitationChainingQueries.js";

// The chaining commands need only id generation, the db, and the clock — every scheduling and ownership
// decision is delegated to the pure `@whetstone/domain` logic, keeping these thin and deterministic.
export type RecitationChainingDependencies = Readonly<{
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

function wholeWorkDto(
  row: RecitationWholeWorkRow | undefined,
  wholeWorkOwned: boolean,
  now: Date
): WholeWorkStateDto {
  if (row === undefined) {
    // Not yet started: it becomes available (due) only once the learner owns the entire Work.
    return { due: wholeWorkOwned, dueAt: null, exists: false };
  }
  // Once started the aggregate prompt runs on its own FSRS schedule, independent of later passage decay.
  return {
    due: row.dueAt.getTime() <= now.getTime(),
    dueAt: row.dueAt.toISOString(),
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

  return {
    chaining: {
      activeChain:
        activeChain === undefined ? null : await chainRowToDto(dependencies.db, activeChain),
      chainEligibility: chainEligibility(masteries, now),
      ownedPrefix: computeOwnedPrefix(masteries, now),
      planEntryId,
      wholeWork: wholeWorkDto(wholeWorkRow, wholeWorkOwned, now),
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

// Apply a targeted Again to a single passage inside a transaction: overwrite its FSRS card and append an
// Again review row. The caller always passes an id drawn from the session's own passages (a chain's
// rendered sequence or the plan's full passage set), so the row is present.
async function applyTargetedAgain(
  tx: DbTransaction,
  createId: () => string,
  passageEntryId: string,
  now: Date
): Promise<void> {
  const [row] = await tx
    .select()
    .from(recitationPassages)
    .where(eq(recitationPassages.entryId, passageEntryId))
    .limit(1);
  const nextState = applyRating(passageRowToReviewState(row!), "again", now);
  await tx
    .update(recitationPassages)
    .set(passageReviewStateColumns(nextState))
    .where(eq(recitationPassages.entryId, passageEntryId));
  await tx.insert(recitationReviews).values({
    cueStrength: "preceding_line",
    id: createId(),
    passageEntryId,
    rating: "again",
    reviewedAt: now
  });
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
      await applyTargetedAgain(tx, dependencies.createId, passageEntryId, now);
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

// Review the whole-work maintenance prompt: apply the aggregate FSRS rating to the plan's separate
// whole-work card (created lazily on first review), and — via the targeted-lapse rule — apply an Again
// to a single identified broken passage without resetting any other. The two FSRS states never merge: a
// whole-work lapse reschedules only the aggregate. Eligible only once the whole Work is owned (until the
// card exists); afterwards it runs on its own schedule. Owner-scoped (`not_found`).
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
  if (existing === undefined && !isWholeWorkOwned(masteries, now)) {
    return { status: "not_eligible" };
  }

  const domainOutcome = toDomainOutcome(outcome);
  const sessionIds = masteries.map((passage) => passage.passageEntryId);
  if (!isOutcomePassageInSession(domainOutcome, sessionIds)) {
    return { reason: "passage_not_in_session", status: "invalid" };
  }

  const priorState =
    existing === undefined ? newReviewState(now) : passageRowToReviewState(existing);
  const nextState = applyRating(priorState, rating, now);
  const columns = passageReviewStateColumns(nextState);

  await dependencies.db.transaction(async (tx) => {
    if (existing === undefined) {
      await tx.insert(recitationWholeWork).values({ createdAt: now, planEntryId, ...columns });
    } else {
      await tx
        .update(recitationWholeWork)
        .set(columns)
        .where(eq(recitationWholeWork.planEntryId, planEntryId));
    }
    for (const passageEntryId of passagesToFailFromOutcome(domainOutcome)) {
      await applyTargetedAgain(tx, dependencies.createId, passageEntryId, now);
    }
  });

  return {
    status: "reviewed",
    wholeWork: {
      due: new Date(nextState.due).getTime() <= now.getTime(),
      dueAt: nextState.due,
      exists: true
    }
  };
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

  // Scan learning plans for the first whose whole-work prompt is due (owned but unstarted, or a started
  // card past its due instant); deterministic order comes from `listLearningPlansForUser`.
  let wholeWorkPlan: Readonly<{ planEntryId: string; workTitle: string }> | undefined;
  for (const plan of await listLearningPlansForUser(dependencies.db, userId)) {
    const masteries = await loadPassageMasteries(dependencies.db, toEntryId(plan.planEntryId));
    const row = await loadWholeWorkForPlan(dependencies.db, plan.planEntryId);
    if (wholeWorkDto(row, isWholeWorkOwned(masteries, now), now).due) {
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
