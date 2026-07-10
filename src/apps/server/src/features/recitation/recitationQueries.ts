import type { RecitationPlanDto } from "@whetstone/contracts";
import type { EntryId } from "@whetstone/domain";
import { and, desc, eq, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { personalEntries, recitationPlans, workMeta } from "../../db/schema.js";

// The columns a recitation-plan DTO is built from, shared by every read. A plan's ownership + chronology
// come from the `personal_entries` facet (the inner join also scopes reads to the owner), and its source
// Work title comes from `work_meta` — the plan links to the Work, whose content stays canonical (#577).
const planColumns = {
  createdAt: personalEntries.createdAt,
  entryId: recitationPlans.entryId,
  lastSessionAt: recitationPlans.lastSessionAt,
  phase: recitationPlans.phase,
  sessionCount: recitationPlans.sessionCount,
  updatedAt: personalEntries.updatedAt,
  workEntryId: recitationPlans.workEntryId,
  workTitle: workMeta.title
} as const;

export type RecitationPlanRow = Readonly<{
  createdAt: Date;
  entryId: string;
  lastSessionAt: Date | null;
  phase: RecitationPlanDto["phase"];
  sessionCount: number;
  updatedAt: Date;
  workEntryId: string;
  workTitle: string;
}>;

export function toRecitationPlanDto(row: RecitationPlanRow): RecitationPlanDto {
  return {
    createdAt: row.createdAt.toISOString(),
    entryId: row.entryId,
    lastSessionAt: row.lastSessionAt === null ? null : row.lastSessionAt.toISOString(),
    phase: row.phase,
    sessionCount: row.sessionCount,
    updatedAt: row.updatedAt.toISOString(),
    workEntryId: row.workEntryId,
    workTitle: row.workTitle
  };
}

// The user's recitation plan for one source Work, or undefined when they have not adopted it — the guard
// the create command uses so a Work is adopted at most once per user (a second adopt is a conflict).
export async function findRecitationPlanForWork(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<RecitationPlanDto | undefined> {
  const [row] = await db
    .select(planColumns)
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(and(eq(recitationPlans.workEntryId, workEntryId), eq(personalEntries.userId, userId)))
    .limit(1);

  return row === undefined ? undefined : toRecitationPlanDto(row);
}

// One owned plan by id, or undefined when it does not exist or belongs to another user — the owner scope
// every mutation (set-phase, record-session) checks before writing, so a forged or cross-user id is 404.
export async function loadOwnedRecitationPlan(
  db: DbClient,
  planEntryId: EntryId,
  userId: string
): Promise<RecitationPlanRow | undefined> {
  const [row] = await db
    .select(planColumns)
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(and(eq(recitationPlans.entryId, planEntryId), eq(personalEntries.userId, userId)))
    .limit(1);

  return row;
}

// Every recitation plan the user owns, newest adopted first (stable id tie-break) — the set the Library
// reads to mark which Works the learner is already reciting, so a Work is never offered for adoption twice.
export async function listRecitationPlans(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<RecitationPlanDto>> {
  const rows = await db
    .select(planColumns)
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(eq(personalEntries.userId, userId))
    .orderBy(desc(personalEntries.createdAt), recitationPlans.entryId);

  return rows.map(toRecitationPlanDto);
}

// Today's "Continue recitation" target: the learner's single most-recently-touched plan, or null when
// they have adopted none. "Touched" = the last reading session if there is one, else when it was adopted
// (`coalesce(last_session_at, created_at)`), so a just-adopted plan surfaces immediately and a practised
// one resurfaces on each session. A stable id tie-break keeps the pick deterministic.
export async function getContinueRecitation(
  db: DbClient,
  userId: string
): Promise<RecitationPlanDto | null> {
  const [row] = await db
    .select(planColumns)
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(eq(personalEntries.userId, userId))
    .orderBy(
      desc(sql`coalesce(${recitationPlans.lastSessionAt}, ${personalEntries.createdAt})`),
      recitationPlans.entryId
    )
    .limit(1);

  return row === undefined ? null : toRecitationPlanDto(row);
}
