import type { RecitationSessionDto } from "@whetstone/contracts";
import type { RecitationPlanObligation, RecitationSessionStep } from "@whetstone/domain";
import {
  chainEligibility,
  isRequiredRecitationStep,
  isUnstartedWholeWorkEligible,
  localDayBoundary,
  selectRecitationSessionStep,
  selectRecitationWork,
  toEntryId
} from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import type { ReviewCardRow } from "../review/reviewCardQueries.js";
import {
  loadActiveChainForPlan,
  loadPassageMasteries,
  loadWholeWorkForPlan
} from "../recitationPassages/recitationChainingQueries.js";
import {
  listPassageRowsForPlan,
  loadRecitationIntroductionStatus,
  loadReviewCardsForTargets
} from "../recitationPassages/recitationPassageQueries.js";
import { listActiveRecitationPlans, type RecitationPlanRow } from "./recitationQueries.js";

export type RecitationSessionDependencies = Readonly<{ db: DbClient }>;

type SessionNewPassage = Readonly<{
  anyIntroduced: boolean;
  available: boolean;
  dailyCap: number;
  introducedToday: number;
  remainingCapacity: number;
}>;

// One unpaused plan's complete session projection: the due-first booleans, the aggregate-facing counts,
// and the presentation fields for its Work. Every field is derived from live passage, chain, whole-Work,
// introduction, and shared review-card rows — no session queue is persisted (#609/#633).
type PlanSessionSlice = Readonly<{
  chainAvailable: boolean;
  dueCount: number;
  earliestDueAtMs: number | null;
  hasDuePassage: boolean;
  newPassage: SessionNewPassage;
  overdueCount: number;
  planEntryId: string;
  step: RecitationSessionStep;
  wholeWorkDue: boolean;
  workTitle: string;
}>;

// Project one unpaused plan into its due-first session slice. Errors propagate to the aggregate loader so
// a partial failure fails the whole routine loud (Today then marks the routine failed, never falsely
// clear — #633 AC2); it must never swallow a load error and report an empty obligation.
async function loadPlanSessionSlice(
  db: DbClient,
  plan: RecitationPlanRow,
  userId: string,
  now: Date,
  timeZone: string
): Promise<PlanSessionSlice> {
  const planEntryId = toEntryId(plan.entryId);

  const passages = await listPassageRowsForPlan(db, planEntryId);
  const cards = await loadReviewCardsForTargets(
    db,
    passages.map((passage) => passage.entryId)
  );
  const activeCards: ReviewCardRow[] = passages
    .filter((passage) => passage.introducedAt !== null)
    .map((passage) => cards.get(passage.entryId))
    .filter((card): card is ReviewCardRow => card !== undefined && card.status === "active");

  const wholeWorkRow = await loadWholeWorkForPlan(db, plan.entryId);
  if (wholeWorkRow !== undefined) {
    activeCards.push(wholeWorkRow.card);
  }

  const { utcStart } = localDayBoundary(now, timeZone);
  const dueCards = activeCards.filter((card) => card.dueAt.getTime() <= now.getTime());
  const earliestDueAtMs =
    dueCards.length === 0 ? null : Math.min(...dueCards.map((card) => card.dueAt.getTime()));

  const introduction = (await loadRecitationIntroductionStatus(
    db,
    planEntryId,
    userId,
    now,
    timeZone
  ))!;
  const masteries = await loadPassageMasteries(db, planEntryId);
  const activeChain = await loadActiveChainForPlan(db, plan.entryId);

  const hasDuePassage = introduction.dueCount > 0;
  const wholeWorkDue =
    wholeWorkRow !== undefined
      ? wholeWorkRow.card.dueAt.getTime() <= now.getTime()
      : isUnstartedWholeWorkEligible(plan.phase, masteries, now);
  // A chain step is offered when there is an active chain to finish OR an eligible owned-prefix to start
  // one inline — so the routine can be completed on the hub without leaving for the chaining page (#609).
  const chainAvailable =
    activeChain !== undefined || chainEligibility(masteries, now).status === "eligible";
  const step = selectRecitationSessionStep({
    chainAvailable,
    hasDuePassage,
    newPassageAvailable: introduction.newPassageAvailable,
    wholeWorkDue
  });

  return {
    chainAvailable,
    dueCount: dueCards.length,
    earliestDueAtMs,
    hasDuePassage,
    newPassage: {
      anyIntroduced: introduction.anyIntroduced,
      available: introduction.newPassageAvailable,
      dailyCap: introduction.dailyCap,
      introducedToday: introduction.introducedToday,
      remainingCapacity: introduction.remainingCapacity
    },
    overdueCount: dueCards.filter((card) => card.dueAt.getTime() < utcStart.getTime()).length,
    planEntryId: plan.entryId,
    step,
    wholeWorkDue,
    workTitle: plan.workTitle
  };
}

// The learner's global recitation routine (#633): one truthful projection aggregated over EVERY unpaused
// plan, not the single most-recently-touched one. It sums the due counts and takes the earliest due
// instant across all Works, then picks the one Work to work now via the pure `selectRecitationWork`
// selector, so Today and the inline session can never report a false all-clear while any Work still holds
// due or required work. The session owns no queue: after each recorded action the client re-fetches this
// projection and the selector re-picks the next focused step.
//
// `pinnedPlanEntryId` is the Work the caller is currently working (the inline session passes its own
// `planEntryId`). While that Work still holds required work it stays selected, so clearing its items
// never context-switches mid-Work after a rating; once it is clear the next Work is chosen
// deterministically. Today's board reads with no pin, yielding the earliest-required Work's summary.
export async function loadRecitationSession(
  dependencies: RecitationSessionDependencies,
  userId: string,
  now: Date,
  timeZone: string,
  pinnedPlanEntryId?: string
): Promise<RecitationSessionDto> {
  const { db } = dependencies;
  const plans = await listActiveRecitationPlans(db, userId);
  if (plans.length === 0) {
    return { status: "no_plan" };
  }

  const slices: PlanSessionSlice[] = [];
  for (const plan of plans) {
    slices.push(await loadPlanSessionSlice(db, plan, userId, now, timeZone));
  }

  const obligations: RecitationPlanObligation[] = slices.map((slice) => ({
    dueCount: slice.dueCount,
    earliestDueAtMs: slice.earliestDueAtMs,
    // A required step with no due card (an eligible chain or an unstarted phase-eligible whole-Work)
    // carries the obligation the aggregate must not lose: without it a Work with real required work but
    // no timestamped card would look empty and let the routine report clear (#633 AC1).
    hasRequiredNonCardStep: isRequiredRecitationStep(slice.step) && slice.dueCount === 0,
    overdueCount: slice.overdueCount,
    planEntryId: slice.planEntryId
  }));

  const selection = selectRecitationWork(obligations, pinnedPlanEntryId ?? null);

  // With required work outstanding, present the selected required Work. Otherwise the routine is clear:
  // present the first Work (stable id order) still offering optional new material, else simply the first,
  // so the learner is invited to new material without any Work deferring required work behind it (AC5).
  const byId = [...slices].sort((a, b) => a.planEntryId.localeCompare(b.planEntryId));
  const activeSlice =
    selection.selectedPlanEntryId !== null
      ? slices.find((slice) => slice.planEntryId === selection.selectedPlanEntryId)!
      : (byId.find((slice) => slice.newPassage.available) ?? byId[0]!);

  // Optional new material is suppressed while any Work holds required work — no Work may hide, defer, or
  // reschedule required work behind an optional invitation (#633 AC5).
  const newPassageAvailable = !selection.hasRequiredWork && activeSlice.newPassage.available;
  const step = selectRecitationSessionStep({
    chainAvailable: activeSlice.chainAvailable,
    hasDuePassage: activeSlice.hasDuePassage,
    newPassageAvailable,
    wholeWorkDue: activeSlice.wholeWorkDue
  });

  return {
    chainAvailable: activeSlice.chainAvailable,
    due: {
      dueCount: selection.due.dueCount,
      nextDueAt:
        selection.due.nextDueAtMs === null
          ? null
          : new Date(selection.due.nextDueAtMs).toISOString(),
      overdueCount: selection.due.overdueCount
    },
    hasDuePassage: activeSlice.hasDuePassage,
    newPassage: { ...activeSlice.newPassage, available: newPassageAvailable },
    planEntryId: activeSlice.planEntryId,
    status: "active",
    step,
    wholeWorkDue: activeSlice.wholeWorkDue,
    workTitle: activeSlice.workTitle
  };
}
