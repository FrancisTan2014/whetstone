import type { RecitationOverviewDto, RecitationReviewDto } from "@whetstone/contracts";
import {
  localDayBoundary,
  selectRecitationWork,
  type RecitationPlanObligation,
  type TodayRoutineSummary
} from "@whetstone/domain";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, recitationWholeWork, reviewCards } from "../../db/schema.js";
import { type ReviewCardRow } from "../review/reviewCardQueries.js";
import {
  listActiveRecitationPlans,
  listRecitationOverviewPlans,
  type RecitationPlanRow
} from "./recitationQueries.js";

// The one Work-level maintenance target a plan owns (#643): its `recitation_whole_work` Entry id and the
// shared FSRS card keyed by that id, scoped to the owner. Undefined when the plan has no active-or-paused
// card (never enrolled, or its maintenance was removed) — the caller then treats the plan as inert.
export type WholeWorkTarget = Readonly<{ card: ReviewCardRow; targetEntryId: string }>;

export async function loadWholeWorkTarget(
  db: DbClient,
  planEntryId: string,
  userId: string
): Promise<WholeWorkTarget | undefined> {
  const [row] = await db
    .select({ card: reviewCards, targetEntryId: recitationWholeWork.entryId })
    .from(recitationWholeWork)
    .innerJoin(
      reviewCards,
      and(
        eq(reviewCards.targetEntryId, recitationWholeWork.entryId),
        eq(reviewCards.userId, userId)
      )
    )
    .where(eq(recitationWholeWork.planEntryId, planEntryId))
    .limit(1);

  return row === undefined ? undefined : { card: row.card, targetEntryId: row.targetEntryId };
}

// Reveal the canonical source for a Work by reading its live blocks (#643): the ordered, non-deleted
// block plaintext joined by newlines. Recitation state NEVER copies the Work text — the review reads it
// straight from the Work's blocks at request time, so an edit to the Work is reflected on the next review.
export async function loadWorkSourceText(db: DbClient, workEntryId: string): Promise<string> {
  const rows = await db
    .select({ plaintext: blocks.plaintext })
    .from(blocks)
    .where(and(eq(blocks.workEntryId, workEntryId), isNull(blocks.deletedAt)))
    .orderBy(asc(blocks.orderIndex));

  return rows.map((row) => row.plaintext).join("\n");
}

// Project one plan + its active Work-level card into the review DTO the client presents (#643): the
// plan/Work identity, the Work title, the canonical source revealed live, and the card's due instant and
// FSRS state. Requires an active card (a paused/removed plan yields no review).
async function toRecitationReviewDto(
  db: DbClient,
  plan: RecitationPlanRow,
  card: ReviewCardRow
): Promise<RecitationReviewDto> {
  return {
    dueAt: card.dueAt.toISOString(),
    planEntryId: plan.entryId,
    sourceText: await loadWorkSourceText(db, plan.workEntryId),
    state: card.state,
    workEntryId: plan.workEntryId,
    workTitle: plan.workTitle
  };
}

// One unpaused plan's canonical recitation obligation from its live Work-level card (#633/#643): due iff
// the card is active and due now; `earliestDueAtMs` is that due instant (null when not due); overdue when
// the card was due before the learner's local day began. A plan whose maintenance was removed has no
// active card, so it carries a zero obligation and never blocks a clear Today.
function toObligation(
  planEntryId: string,
  card: ReviewCardRow | undefined,
  now: Date,
  dayStartMs: number
): RecitationPlanObligation {
  const dueAtMs = card !== undefined && card.status === "active" ? card.dueAt.getTime() : null;
  const due = dueAtMs !== null && dueAtMs <= now.getTime();
  return {
    dueCount: due ? 1 : 0,
    earliestDueAtMs: due ? dueAtMs : null,
    overdueCount: due && dueAtMs! < dayStartMs ? 1 : 0,
    planEntryId
  };
}

export type RecitationReviewDependencies = Readonly<{ db: DbClient }>;

// The learner's Recitation routine summary for Today (#610/#643): the aggregate due counts across every
// unpaused plan's Work-level maintenance card, folded through the pure #633 selector so cross-Work
// ordering is preserved. `nextDueAt` is non-null exactly when some Work's card is due, so Today keys the
// Recitation row's due-ness off it and passage/chain/introduction state never contributes.
export async function loadRecitationRoutineSummary(
  dependencies: RecitationReviewDependencies,
  userId: string,
  now: Date,
  timeZone: string
): Promise<TodayRoutineSummary> {
  const { db } = dependencies;
  const plans = await listActiveRecitationPlans(db, userId);
  const { utcStart } = localDayBoundary(now, timeZone);
  const dayStartMs = utcStart.getTime();

  const obligations: RecitationPlanObligation[] = [];
  for (const plan of plans) {
    const target = await loadWholeWorkTarget(db, plan.entryId, userId);
    obligations.push(toObligation(plan.entryId, target?.card, now, dayStartMs));
  }

  const { due } = selectRecitationWork(obligations, null);
  return {
    dueCount: due.dueCount,
    nextDueAt: due.nextDueAtMs === null ? null : new Date(due.nextDueAtMs).toISOString(),
    overdueCount: due.overdueCount
  };
}

// The single Work-level review to open (#643). With a `workEntryId` the caller opens THAT exact Work's
// review right after enrolling it — the just-seeded card is due now, so the review is returned whether or
// not it is strictly due; a Work the learner does not own (or whose maintenance was removed) yields null,
// so the client routes to a Library recovery path instead of a dead screen. With no `workEntryId` (Today's
// "start recitation") the earliest-due Work is chosen by the #633 selector, or null when nothing is due.
export async function loadRecitationReview(
  dependencies: RecitationReviewDependencies,
  userId: string,
  now: Date,
  workEntryId?: string
): Promise<RecitationReviewDto | null> {
  const { db } = dependencies;

  if (workEntryId !== undefined) {
    const plan = await loadOwnedPlanForWork(db, workEntryId, userId);
    if (plan === undefined) {
      return null;
    }
    const target = await loadWholeWorkTarget(db, plan.entryId, userId);
    if (target === undefined || target.card.status !== "active") {
      return null;
    }
    return toRecitationReviewDto(db, plan, target.card);
  }

  const plans = await listActiveRecitationPlans(db, userId);
  const obligations: RecitationPlanObligation[] = [];
  const cards = new Map<string, ReviewCardRow>();
  for (const plan of plans) {
    const target = await loadWholeWorkTarget(db, plan.entryId, userId);
    if (target !== undefined && target.card.status === "active") {
      cards.set(plan.entryId, target.card);
    }
    obligations.push(toObligation(plan.entryId, target?.card, now, now.getTime()));
  }

  const { selectedPlanEntryId } = selectRecitationWork(obligations, null);
  if (selectedPlanEntryId === null) {
    return null;
  }
  const plan = plans.find((candidate) => candidate.entryId === selectedPlanEntryId)!;
  return toRecitationReviewDto(db, plan, cards.get(selectedPlanEntryId)!);
}

// One owned plan by its source Work, or undefined when the learner does not recite that Work — the guard
// the review-by-Work read and the record-review command use so a review always keeps the exact Work's
// identity and never opens another learner's plan.
async function loadOwnedPlanForWork(
  db: DbClient,
  workEntryId: string,
  userId: string
): Promise<RecitationPlanRow | undefined> {
  const plans = await listActiveRecitationPlans(db, userId);
  return plans.find((plan) => plan.workEntryId === workEntryId);
}

// The Recite home payload (#638): every enrolled Work with its live due state and next review date, read
// straight from its Work-level maintenance card. A Work whose maintenance was removed has no active card,
// so it carries a null schedule and is never due; a paused Work keeps its scheduled `nextReviewAt` but is
// never due while paused. `dueCount` is the number of Works due now, so the landing can lead with due
// maintenance without recomputing it client-side. Newest-enrolled order is preserved from the plan read.
export async function loadRecitationOverview(
  dependencies: RecitationReviewDependencies,
  userId: string,
  now: Date
): Promise<RecitationOverviewDto> {
  const { db } = dependencies;
  const plans = await listRecitationOverviewPlans(db, userId);

  const works: RecitationOverviewDto["works"] = [];
  let dueCount = 0;
  for (const plan of plans) {
    const target = await loadWholeWorkTarget(db, plan.entryId, userId);
    const paused = plan.pausedAt !== null;
    const isDue =
      target !== undefined &&
      target.card.status === "active" &&
      !paused &&
      target.card.dueAt.getTime() <= now.getTime();
    if (isDue) {
      dueCount += 1;
    }
    works.push({
      isDue,
      // The card keeps its schedule while paused (only removal drops the card), so a paused Work still
      // shows its preserved next review date; a removed Work has no card and no schedule.
      nextReviewAt: target === undefined ? null : target.card.dueAt.toISOString(),
      paused,
      planEntryId: plan.entryId,
      state: target === undefined ? null : target.card.state,
      workEntryId: plan.workEntryId,
      workTitle: plan.workTitle
    });
  }

  return { dueCount, works };
}

// from the canonical cards through the pure #633 selector, with no persisted queue or cursor. Called
// straight after a rating so the review UI can decide between an optional "Review next" and "Due
// complete" — the just-rated card is rescheduled forward and so is naturally not counted here. Overdue
// is irrelevant to the count, so "now" doubles as the day boundary (only overdue would need the zone).
export async function countDueRecitationWork(
  dependencies: RecitationReviewDependencies,
  userId: string,
  now: Date
): Promise<number> {
  const { db } = dependencies;
  const plans = await listActiveRecitationPlans(db, userId);
  const obligations: RecitationPlanObligation[] = [];
  for (const plan of plans) {
    const target = await loadWholeWorkTarget(db, plan.entryId, userId);
    obligations.push(toObligation(plan.entryId, target?.card, now, now.getTime()));
  }
  return selectRecitationWork(obligations, null).due.dueCount;
}
