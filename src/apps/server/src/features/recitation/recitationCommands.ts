import type {
  RecitationPlanDto,
  RecitationReviewDto,
  RecitationReviewRating
} from "@whetstone/contracts";
import { RECITATION_REQUEST_RETENTION, toEntryId, type EntryId } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  entries,
  entryLinks,
  personalEntries,
  recitationPlans,
  recitationWholeWork,
  reviewCards,
  workMeta
} from "../../db/schema.js";
import {
  applyRatingToCardInTx,
  deleteReviewCard,
  pauseReviewCard,
  resumeReviewCard,
  seedReviewCard
} from "../review/reviewCardCommands.js";
import { findRecitationPlanForWork, loadOwnedRecitationPlan } from "./recitationQueries.js";
import { loadWholeWorkTarget, loadWorkSourceText } from "./recitationReviewQueries.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the recitation commands
// stay deterministic and testable. Direct maintenance (#643) never copies a Work's content: enrolment
// writes a durable `recitation_plan` identity Entry (owned via `personal_entries`), one Work-level
// `recitation_whole_work` target linked to the plan, and one shared `review_cards` row that owns the FSRS
// schedule. `createEntryId` mints the plan/target Entry ids; `createId` stamps each appended review event.
export type RecitationDependencies = Readonly<{
  createEntryId: () => string;
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type EnrollRecitationResult =
  | Readonly<{ plan: RecitationPlanDto; status: "enrolled" }>
  | Readonly<{ status: "work_not_found" }>;

async function loadWorkTitle(db: DbClient, workEntryId: EntryId): Promise<string | undefined> {
  const [row] = await db
    .select({ title: workMeta.title })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);

  return row?.title;
}

// Create the plan's durable identity Entry the first time a Work is enrolled: the `recitation_plan` Entry,
// its owning `personal_entries` facet (which dates it on the Timeline and scopes it to the learner), and
// the plan row itself. Direct maintenance always lands the plan in `maintenance` — there is no phase
// picker (#643). Returns the new plan Entry id.
async function insertPlan(
  tx: Transaction,
  dependencies: RecitationDependencies,
  workEntryId: EntryId,
  userId: string,
  now: Date
): Promise<string> {
  const planEntryId = dependencies.createEntryId();
  await tx.insert(entries).values({ id: planEntryId, type: "recitation_plan" });
  await tx
    .insert(personalEntries)
    .values({ createdAt: now, entryId: planEntryId, occurredAt: now, updatedAt: now, userId });
  await tx.insert(recitationPlans).values({
    entryId: planEntryId,
    lastSessionAt: null,
    phase: "maintenance",
    sessionCount: 0,
    workEntryId
  });
  return planEntryId;
}

// Ensure the plan owns exactly ONE active Work-level maintenance target + card, due now (#643). On first
// enrolment the `recitation_whole_work` Entry is created, linked to its plan by a `contains` entry-link,
// and seeded a fresh 0.95 card due immediately. Re-enrolling reuses the same target: a removed card is
// re-seeded (fresh maintenance), a paused card is resumed in place, and an already-active card is left
// untouched — so enrolment is idempotent and never duplicates the target, card, or resets a live schedule.
async function ensureWholeWorkCard(
  tx: Transaction,
  dependencies: RecitationDependencies,
  planEntryId: string,
  userId: string,
  now: Date
): Promise<void> {
  const [targetRow] = await tx
    .select({ entryId: recitationWholeWork.entryId })
    .from(recitationWholeWork)
    .where(eq(recitationWholeWork.planEntryId, planEntryId))
    .limit(1);

  let targetEntryId: string;
  if (targetRow === undefined) {
    targetEntryId = dependencies.createEntryId();
    await tx.insert(entries).values({ id: targetEntryId, type: "recitation_whole_work" });
    await tx
      .insert(recitationWholeWork)
      .values({ createdAt: now, entryId: targetEntryId, planEntryId });
    await tx.insert(entryLinks).values({
      fromEntryId: planEntryId,
      toEntryId: targetEntryId,
      type: "contains"
    });
  } else {
    targetEntryId = targetRow.entryId;
  }

  const [card] = await tx
    .select({ status: reviewCards.status })
    .from(reviewCards)
    .where(and(eq(reviewCards.targetEntryId, targetEntryId), eq(reviewCards.userId, userId)))
    .limit(1);

  if (card === undefined) {
    await seedReviewCard(tx, {
      now,
      requestedRetention: RECITATION_REQUEST_RETENTION,
      targetEntryId,
      userId
    });
    return;
  }
  if (card.status === "paused") {
    await tx
      .update(reviewCards)
      .set({ status: "active", updatedAt: now })
      .where(eq(reviewCards.targetEntryId, targetEntryId));
  }
}

// Enroll a known Work into direct Recitation maintenance ("I can recite this"): create-or-reuse ONE
// owner-scoped plan, ONE Work-level target, and ONE active card due now — all in one transaction so a
// half-enrolment never lands (#643). Eligible Works are any Work (imported or authored) → `work_not_found`
// when the id is unknown. Enrolment persists BEFORE any review opens and infers no rating. Repeating it is
// idempotent (never a duplicate plan/target/history); an existing plan with no active target — a paused or
// removed one — is converted to maintenance in place, preserving its durable identity.
export async function enrollRecitation(
  dependencies: RecitationDependencies,
  workEntryId: string,
  userId: string
): Promise<EnrollRecitationResult> {
  const workId = toEntryId(workEntryId);
  const workTitle = await loadWorkTitle(dependencies.db, workId);
  if (workTitle === undefined) {
    return { status: "work_not_found" };
  }

  const existing = await findRecitationPlanForWork(dependencies.db, workId, userId);
  const now = dependencies.now();

  await dependencies.db.transaction(async (tx) => {
    const planEntryId =
      existing === undefined
        ? await insertPlan(tx, dependencies, workId, userId, now)
        : existing.entryId;
    if (existing !== undefined) {
      // Convert an existing (possibly paused) plan back to active maintenance without touching its
      // durable identity: clear any pause and land it in `maintenance`.
      await tx
        .update(recitationPlans)
        .set({ pausedAt: null, phase: "maintenance" })
        .where(eq(recitationPlans.entryId, planEntryId));
    }
    await ensureWholeWorkCard(tx, dependencies, planEntryId, userId, now);
  });

  const plan = await findRecitationPlanForWork(dependencies.db, workId, userId);
  // The plan was just created-or-reused in this request, so it is always present.
  return { plan: plan!, status: "enrolled" };
}

export type RecordRecitationReviewResult =
  | Readonly<{ review: RecitationReviewDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>;

// Record one Work-level maintenance review (#643): rate the plan's single Work-level card through the
// shared FSRS boundary, appending exactly ONE review event and rescheduling ONLY that card. No rating is
// inferred, no cue-strength evidence is written, and no targeted passage repair is created (v0 non-goal).
// Owner-scoped: a forged, cross-user, or unenrolled plan id is `not_found`. Returns the rescheduled review
// with the card's next due instant and FSRS state.
export async function recordRecitationReview(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  rating: RecitationReviewRating,
  userId: string
): Promise<RecordRecitationReviewResult> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }
  const target = await loadWholeWorkTarget(dependencies.db, planEntryId, userId);
  if (target === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const { card } = await dependencies.db.transaction((tx) =>
    applyRatingToCardInTx(tx, target.card, rating, now, dependencies.createId())
  );

  return {
    review: {
      dueAt: card.dueAt.toISOString(),
      planEntryId: owned.entryId,
      sourceText: await loadWorkSourceText(dependencies.db, owned.workEntryId),
      state: card.state,
      workEntryId: owned.workEntryId,
      workTitle: owned.workTitle
    },
    status: "recorded"
  };
}

export type RecitationMaintenanceResult = "not_found" | "updated";

// Pause maintenance for a plan (#608/#643): stamp the plan's `paused_at` and withhold its Work-level card
// from the due scan, WITHOUT deleting the plan, target, schedule, or history — resuming restores the exact
// card. Owner-scoped (`not_found`); idempotent. The Work and its source content are untouched.
export async function pauseRecitation(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<RecitationMaintenanceResult> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return "not_found";
  }
  const now = dependencies.now();
  await dependencies.db
    .update(recitationPlans)
    .set({ pausedAt: now })
    .where(eq(recitationPlans.entryId, planEntryId));
  const target = await loadWholeWorkTarget(dependencies.db, planEntryId, userId);
  if (target !== undefined) {
    await pauseReviewCard(dependencies.db, target.targetEntryId, userId, now);
  }
  return "updated";
}

// Resume a paused plan (#608/#643): clear `paused_at` and return its preserved Work-level card to the due
// scan. Owner-scoped (`not_found`); idempotent.
export async function resumeRecitation(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<RecitationMaintenanceResult> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return "not_found";
  }
  const now = dependencies.now();
  await dependencies.db
    .update(recitationPlans)
    .set({ pausedAt: null })
    .where(eq(recitationPlans.entryId, planEntryId));
  const target = await loadWholeWorkTarget(dependencies.db, planEntryId, userId);
  if (target !== undefined) {
    await resumeReviewCard(dependencies.db, target.targetEntryId, userId, now);
  }
  return "updated";
}

// Remove maintenance for a plan (#643): drop the Work-level card so the Work stops surfacing as due, while
// preserving the plan identity, the target Entry, the append-only review history, and — always — the Work
// and its source content. Owner-scoped (`not_found`); idempotent. A later enrolment reuses the same target
// and seeds a fresh maintenance card.
export async function removeRecitation(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<RecitationMaintenanceResult> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return "not_found";
  }
  const target = await loadWholeWorkTarget(dependencies.db, planEntryId, userId);
  if (target !== undefined) {
    await dependencies.db.transaction((tx) => deleteReviewCard(tx, target.targetEntryId));
  }
  return "updated";
}
