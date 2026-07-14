import type { RecitationSessionDto } from "@whetstone/contracts";
import {
  chainEligibility,
  isUnstartedWholeWorkEligible,
  localDayBoundary,
  selectRecitationSessionStep,
  toEntryId
} from "@whetstone/domain";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recitationPlans } from "../../db/schema.js";
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
import { getContinueRecitation } from "./recitationQueries.js";

export type RecitationSessionDependencies = Readonly<{ db: DbClient }>;

async function loadPlanPausedAt(db: DbClient, planEntryId: string): Promise<Date | null> {
  const [row] = await db
    .select({ pausedAt: recitationPlans.pausedAt })
    .from(recitationPlans)
    .where(eq(recitationPlans.entryId, planEntryId))
    .limit(1);
  return row?.pausedAt ?? null;
}

// The complete recitation session projection (#609): a transient due-first sequence over the learner's
// most-recently-touched plan, recomputed from canonical passage, chain, whole-work, introduction, and
// shared review-card rows. It persists no session queue; after every action the client asks for this
// projection again and the selector chooses the next focused inline step.
export async function loadRecitationSession(
  dependencies: RecitationSessionDependencies,
  userId: string,
  now: Date,
  timeZone: string
): Promise<RecitationSessionDto> {
  const { db } = dependencies;
  const plan = await getContinueRecitation(db, userId);
  if (plan === null) {
    return { status: "no_plan" };
  }
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

  const paused = (await loadPlanPausedAt(db, plan.entryId)) !== null;
  const { utcStart } = localDayBoundary(now, timeZone);
  const dueCards = activeCards.filter((card) => card.dueAt.getTime() <= now.getTime());
  const due = {
    dueCount: paused ? 0 : dueCards.length,
    overdueCount: paused
      ? 0
      : dueCards.filter((card) => card.dueAt.getTime() < utcStart.getTime()).length
  };

  const introduction = (await loadRecitationIntroductionStatus(
    db,
    planEntryId,
    userId,
    now,
    timeZone
  ))!;
  const masteries = await loadPassageMasteries(db, planEntryId);
  const activeChain = await loadActiveChainForPlan(db, plan.entryId);

  const hasDuePassage = !paused && introduction.dueCount > 0;
  const wholeWorkDue =
    !paused &&
    (wholeWorkRow !== undefined
      ? wholeWorkRow.card.dueAt.getTime() <= now.getTime()
      : isUnstartedWholeWorkEligible(plan.phase, masteries, now));
  // A chain step is offered when there is an active chain to finish OR an eligible owned-prefix to start
  // one inline — so the routine can be completed on the hub without leaving for the chaining page (#609).
  const chainAvailable =
    !paused &&
    (activeChain !== undefined || chainEligibility(masteries, now).status === "eligible");
  const newPassageAvailable = !paused && introduction.newPassageAvailable;
  const step = selectRecitationSessionStep({
    chainAvailable,
    hasDuePassage,
    newPassageAvailable,
    wholeWorkDue
  });

  return {
    chainAvailable,
    due,
    hasDuePassage,
    newPassage: {
      anyIntroduced: introduction.anyIntroduced,
      available: newPassageAvailable,
      dailyCap: introduction.dailyCap,
      introducedToday: introduction.introducedToday,
      remainingCapacity: introduction.remainingCapacity
    },
    paused,
    planEntryId: plan.entryId,
    status: "active",
    step,
    wholeWorkDue,
    workTitle: plan.workTitle
  };
}
