import type {
  CreateRecitationPlanRequest,
  RecitationPhaseDto,
  RecitationPlanDto
} from "@whetstone/contracts";
import { toEntryId, type EntryId } from "@whetstone/domain";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, personalEntries, recitationPlans, workMeta } from "../../db/schema.js";
import {
  findRecitationPlanForWork,
  loadOwnedRecitationPlan,
  toRecitationPlanDto
} from "./recitationQueries.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the recitation commands
// stay deterministic and testable. Adopting a Work as a recitation routine (#577) never copies its
// content: it writes a `recitation_plan` Entry that references the source Work, plus a `personal_entries`
// facet that marks it owned and dates it on the learner's Timeline. Per-session routine state lives on the
// plan row and is updated in place — it is not an Entry and does not feed FSRS.
export type RecitationDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
  now: () => Date;
}>;

export type CreateRecitationPlanResult =
  | Readonly<{ status: "created"; plan: RecitationPlanDto }>
  | Readonly<{ status: "work_not_found" }>
  | Readonly<{ status: "already_exists"; plan: RecitationPlanDto }>;

export type RecitationPlanMutationResult =
  | Readonly<{ status: "updated"; plan: RecitationPlanDto }>
  | Readonly<{ status: "not_found" }>;

async function loadWorkTitle(db: DbClient, workEntryId: EntryId): Promise<string | undefined> {
  const [row] = await db
    .select({ title: workMeta.title })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);

  return row?.title;
}

// Adopt a source Work as a recitation routine in the learner's chosen initial phase. Eligible Works are
// any Work — imported or authored — so this only checks the Work exists (`work_not_found` otherwise). A
// Work is adopted at most once per user: a second adopt returns the existing plan as `already_exists`
// rather than creating a duplicate. The write is one transaction so a plan never lands half-created.
export async function createRecitationPlan(
  dependencies: RecitationDependencies,
  request: CreateRecitationPlanRequest,
  userId: string
): Promise<CreateRecitationPlanResult> {
  const workEntryId = toEntryId(request.workEntryId);

  const workTitle = await loadWorkTitle(dependencies.db, workEntryId);
  if (workTitle === undefined) {
    return { status: "work_not_found" };
  }

  const existing = await findRecitationPlanForWork(dependencies.db, workEntryId, userId);
  if (existing !== undefined) {
    return { plan: existing, status: "already_exists" };
  }

  const now = dependencies.now();
  const planEntryId = dependencies.createEntryId();

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: planEntryId, type: "recitation_plan" });
    await tx
      .insert(personalEntries)
      .values({ createdAt: now, entryId: planEntryId, occurredAt: now, updatedAt: now, userId });
    await tx.insert(recitationPlans).values({
      entryId: planEntryId,
      lastSessionAt: null,
      phase: request.phase,
      sessionCount: 0,
      workEntryId
    });
  });

  const iso = now.toISOString();
  return {
    plan: {
      createdAt: iso,
      entryId: planEntryId,
      lastSessionAt: null,
      phase: request.phase,
      sessionCount: 0,
      updatedAt: iso,
      workEntryId,
      workTitle
    },
    status: "created"
  };
}

// The explicit, learner-driven phase transition (e.g. "Start reciting"): set the plan's phase and bump the
// Entry's `updated_at`. Owner-scoped via `personal_entries` (a forged or cross-user id is `not_found`).
// This is the only path that changes a phase — whetstone never infers readiness or auto-advances.
export async function setRecitationPhase(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  phase: RecitationPhaseDto,
  userId: string
): Promise<RecitationPlanMutationResult> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  await dependencies.db
    .update(recitationPlans)
    .set({ phase })
    .where(eq(recitationPlans.entryId, planEntryId));
  await dependencies.db
    .update(personalEntries)
    .set({ updatedAt: now })
    .where(eq(personalEntries.entryId, planEntryId));

  return { plan: toRecitationPlanDto({ ...owned, phase, updatedAt: now }), status: "updated" };
}

// Pause or resume a plan (#608). Pausing stamps `paused_at` (`now`); resuming clears it. Paused is a
// single nullable column — it removes the plan's cards from ALL cross-plan due/Today selection without
// deleting any progress, schedule, support levels, chains, or history, so resuming restores everything
// untouched. Owner-scoped via `loadOwnedRecitationPlan` (a forged or cross-user id is `not_found`).
// Idempotent: pausing an already-paused plan (or resuming an active one) simply re-writes the same state.
export async function setRecitationPlanPaused(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  paused: boolean,
  userId: string
): Promise<"not_found" | "updated"> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return "not_found";
  }

  await dependencies.db
    .update(recitationPlans)
    .set({ pausedAt: paused ? dependencies.now() : null })
    .where(eq(recitationPlans.entryId, planEntryId));

  return "updated";
}
// routine state (#577) — it deliberately does NOT touch `personal_entries`, so a familiarizing session
// never creates a Timeline row and never feeds FSRS. Owner-scoped (a forged/cross-user id is `not_found`).
export async function recordRecitationSession(
  dependencies: RecitationDependencies,
  planEntryId: EntryId,
  userId: string
): Promise<RecitationPlanMutationResult> {
  const owned = await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId);
  if (owned === undefined) {
    return { status: "not_found" };
  }

  const lastSessionAt = dependencies.now();
  const sessionCount = owned.sessionCount + 1;
  await dependencies.db
    .update(recitationPlans)
    .set({ lastSessionAt, sessionCount })
    .where(eq(recitationPlans.entryId, planEntryId));

  return {
    plan: toRecitationPlanDto({ ...owned, lastSessionAt, sessionCount }),
    status: "updated"
  };
}
