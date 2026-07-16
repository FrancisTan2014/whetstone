import type { RecitationHubDto } from "@whetstone/contracts";
import {
  chainEligibility,
  deriveRecitationStage,
  isUnstartedWholeWorkEligible,
  localDayBoundary,
  selectRecitationTodayAction,
  toEntryId
} from "@whetstone/domain";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recitationPlans, workMeta } from "../../db/schema.js";
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
import {
  findRecitationPlanForWork,
  getContinueRecitation,
  type RecitationPlanRow
} from "./recitationQueries.js";

export type RecitationHubDependencies = Readonly<{ db: DbClient }>;

// The plan's `paused_at` (#608), or null when active. A tiny scoped read so the hub does not need to
// widen the shared plan DTO with a pause column every other reader would carry.
async function loadPlanPausedAt(db: DbClient, planEntryId: string): Promise<Date | null> {
  const [row] = await db
    .select({ pausedAt: recitationPlans.pausedAt })
    .from(recitationPlans)
    .where(eq(recitationPlans.entryId, planEntryId))
    .limit(1);
  return row?.pausedAt ?? null;
}

// The title of one source Work, or undefined when no such Work exists — the read the contextual hub uses
// to present a requested-but-unadopted Work's adoption state without needing a plan (#633 AC7).
async function loadWorkTitle(db: DbClient, workEntryId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ title: workMeta.title })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);
  return row?.title;
}

// The shape the hub projection needs from a resolved plan, satisfied by both the most-recent read and the
// work-scoped read.
type HubPlan = Readonly<{ entryId: string; phase: RecitationPlanRow["phase"]; workTitle: string }>;

// The recitation routine hub (#608): one calm projection of the learner's most-recently-touched plan —
// or, when a `?work=` deep-link is given, THAT exact owner-scoped plan (#633 AC7) — composed PURELY from
// canonical rows joined to the shared card state; it persists no parallel progress, stage flag, or copied
// due date. No adopted plan → the restrained `no_plan` empty state; a requested-but-unadopted Work →
// `unadopted_work` (that Work's adoption state, never a fallback to another plan). Otherwise the active
// projection: passage progress, due/overdue obligations over the plan's active passage + whole-Work
// cards, the paced-introduction status (#607), the derived routine stage, and the single due-first action.
//
// A PAUSED plan is still shown (with all its progress) but surfaces no obligation or action: its due
// counts are zeroed and its primary action is `none`, mirroring how the cross-plan due scans already
// exclude it — so pausing quietly removes the plan from "what needs attention now" without losing state.
export async function loadRecitationHub(
  dependencies: RecitationHubDependencies,
  userId: string,
  now: Date,
  timeZone: string,
  workEntryId?: string
): Promise<RecitationHubDto> {
  const { db } = dependencies;

  // Contextual entry (#633 AC7): a `?work=` deep-link opens THAT exact owner-scoped plan, never the
  // most-recently-touched one. When the learner has not adopted the requested Work, present that Work's
  // adoption state (its title) so the hub routes back toward adoption — it never falls back to any plan.
  if (workEntryId !== undefined) {
    const scopedPlan = await findRecitationPlanForWork(db, toEntryId(workEntryId), userId);
    if (scopedPlan === undefined) {
      const workTitle = await loadWorkTitle(db, workEntryId);
      return workTitle === undefined
        ? { status: "no_plan" }
        : { status: "unadopted_work", workEntryId, workTitle };
    }
    return projectHubPlan(db, scopedPlan, userId, now, timeZone);
  }

  // Default entry: the learner's most-recently-touched plan (#608), or the restrained no-plan state.
  const plan = await getContinueRecitation(db, userId);
  return plan === null ? { status: "no_plan" } : projectHubPlan(db, plan, userId, now, timeZone);
}

async function projectHubPlan(
  db: DbClient,
  plan: HubPlan,
  userId: string,
  now: Date,
  timeZone: string
): Promise<RecitationHubDto> {
  const planEntryId = toEntryId(plan.entryId);

  const passages = await listPassageRowsForPlan(db, planEntryId);
  const cards = await loadReviewCardsForTargets(
    db,
    passages.map((passage) => passage.entryId)
  );
  const introducedCount = passages.filter((passage) => passage.introducedAt !== null).length;

  const pausedAt = await loadPlanPausedAt(db, plan.entryId);
  const paused = pausedAt !== null;

  const wholeWorkRow = await loadWholeWorkForPlan(db, plan.entryId);
  const masteries = await loadPassageMasteries(db, planEntryId);
  const activeChain = await loadActiveChainForPlan(db, plan.entryId);

  // Ownership was already proven while resolving the plan, so the introduction status is always present.
  const introduction = (await loadRecitationIntroductionStatus(
    db,
    planEntryId,
    userId,
    now,
    timeZone
  ))!;

  // Due/overdue over the plan's ACTIVE shared cards: introduced passage cards plus the whole-Work card.
  const activeCards: ReviewCardRow[] = passages
    .filter((passage) => passage.introducedAt !== null)
    .map((passage) => cards.get(passage.entryId))
    .filter((card): card is ReviewCardRow => card !== undefined && card.status === "active");
  if (wholeWorkRow !== undefined) {
    activeCards.push(wholeWorkRow.card);
  }
  const { utcStart } = localDayBoundary(now, timeZone);
  const dueCards = activeCards.filter((card) => card.dueAt.getTime() <= now.getTime());
  // Overdue is the subset carried over from a previous local day (due before the local-day boundary), so
  // `overdueCount <= dueCount` always. A paused plan surfaces neither.
  const dueCount = paused ? 0 : dueCards.length;
  const overdueCount = paused
    ? 0
    : dueCards.filter((card) => card.dueAt.getTime() < utcStart.getTime()).length;

  const eligibility = chainEligibility(masteries, now);
  const stage = deriveRecitationStage({
    chainEligible: eligibility.status === "eligible",
    hasActiveChain: activeChain !== undefined,
    phase: plan.phase
  });

  // The due-first session action, scoped to THIS plan (due passage > active chain > whole-Work > none).
  // `introduction.dueCount` is exactly this plan's active introduced passages that are due. When paused,
  // every arm is false, so the action is `none`.
  const wholeWorkDue =
    wholeWorkRow !== undefined
      ? wholeWorkRow.card.dueAt.getTime() <= now.getTime()
      : isUnstartedWholeWorkEligible(plan.phase, masteries, now);
  const primaryAction = selectRecitationTodayAction({
    hasActiveChain: !paused && activeChain !== undefined,
    hasDuePassage: !paused && introduction.dueCount > 0,
    wholeWorkDue: !paused && wholeWorkDue
  });

  return {
    due: { dueCount, overdueCount },
    introduction,
    passages: { introducedCount, totalCount: passages.length },
    paused,
    phase: plan.phase,
    planEntryId: plan.entryId,
    primaryAction,
    stage,
    status: "active",
    workTitle: plan.workTitle
  };
}
