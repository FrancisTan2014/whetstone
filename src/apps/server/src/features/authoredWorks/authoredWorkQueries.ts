import { toEntryId, type EntryId } from "@whetstone/domain";
import type { AuthoredWorkDto, AuthoredWorkSummaryDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, asc, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { docBlocks, personalEntries, readingUnits, workMeta } from "../../db/schema.js";

// The columns a lightweight authored-Work summary is built from, shared by the list and continue queries.
// Authored (owned) Works are exactly the `work_meta` rows that also carry a `personal_entries` facet for
// the user — an imported/shared Work has no such facet — so the inner join IS the authored discriminator.
const summaryColumns = {
  createdAt: personalEntries.createdAt,
  entryId: workMeta.entryId,
  language: workMeta.language,
  title: workMeta.title,
  updatedAt: personalEntries.updatedAt,
  workType: workMeta.workType
} as const;

type SummaryRow = Readonly<{
  createdAt: Date;
  entryId: string;
  language: AuthoredWorkSummaryDto["language"];
  title: string;
  updatedAt: Date;
  workType: AuthoredWorkSummaryDto["workType"];
}>;

function toSummaryDto(row: SummaryRow): AuthoredWorkSummaryDto {
  return {
    createdAt: row.createdAt.toISOString(),
    entryId: row.entryId,
    language: row.language,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    workType: row.workType
  };
}

// The authored Work with its reassembled canonical document — what the editor loads to edit or read. The
// document is rebuilt from the ordered `doc_blocks` rows (each a top-level node), so the reader renders it
// through the same PM pipeline as imported content. Scoped to the owner via `personal_entries`: an unknown
// id, another user's Work, or an imported Work returns `undefined` (→ 404).
export async function loadAuthoredWorkForEditing(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<AuthoredWorkDto | undefined> {
  const [owned] = await db
    .select({
      createdAt: personalEntries.createdAt,
      language: workMeta.language,
      title: workMeta.title,
      unitEntryId: readingUnits.entryId,
      updatedAt: personalEntries.updatedAt,
      workType: workMeta.workType
    })
    .from(workMeta)
    .innerJoin(personalEntries, eq(personalEntries.entryId, workMeta.entryId))
    .innerJoin(readingUnits, eq(readingUnits.workEntryId, workMeta.entryId))
    .where(and(eq(workMeta.entryId, workEntryId), eq(personalEntries.userId, userId)))
    .limit(1);

  if (owned === undefined) {
    return undefined;
  }

  const blockRows = await db
    .select({ node: docBlocks.nodeJson, orderIndex: docBlocks.orderIndex })
    .from(docBlocks)
    .where(eq(docBlocks.readingUnitEntryId, owned.unitEntryId))
    .orderBy(asc(docBlocks.orderIndex));

  const document: DocumentNodeJSON = {
    content: blockRows.map((row) => row.node as DocumentNodeJSON),
    type: "doc"
  };

  return {
    createdAt: owned.createdAt.toISOString(),
    document,
    entryId: toEntryId(workEntryId),
    language: owned.language,
    title: owned.title,
    unitEntryId: owned.unitEntryId,
    updatedAt: owned.updatedAt.toISOString(),
    workType: owned.workType
  };
}

// Every authored Work the user owns, most recently edited first (with a stable id tie-break) — the set the
// Library uses to badge owned drafts and route them to the editor instead of the reader.
export async function listAuthoredWorks(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<AuthoredWorkSummaryDto>> {
  const rows = await db
    .select(summaryColumns)
    .from(workMeta)
    .innerJoin(personalEntries, eq(personalEntries.entryId, workMeta.entryId))
    .where(eq(personalEntries.userId, userId))
    .orderBy(desc(personalEntries.updatedAt), asc(workMeta.entryId));

  return rows.map(toSummaryDto);
}

// The learner's most recently edited authored Work, or null when they have authored nothing — Today's
// "Continue writing" target. No publish/finish flow exists in v0, so "unfinished" is simply the latest
// authored Work by `updated_at`.
export async function getLatestAuthoredWorkInProgress(
  db: DbClient,
  userId: string
): Promise<AuthoredWorkSummaryDto | null> {
  const works = await listAuthoredWorks(db, userId);
  return works[0] ?? null;
}
