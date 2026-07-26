import { toEntryId, type EntryId } from "@whetstone/domain";
import type { ImportedWorkDto, ImportedWorkUnitDto } from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";
import { and, eq, sql, type SQL } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, docBlocks, readingUnits, workMeta } from "../../db/schema.js";
import { loadManualWorkDocument, loadManualWorkSections } from "./manualWorkContentQueries.js";

// Canonical-content eligibility for imported correction (#762). An imported Work is correctable only when
// its COMPLETE readable hierarchy is canonical `doc_blocks`: it carries at least one `doc_blocks` row AND
// no reading unit still renders from legacy mdast — that is, no live (`deleted_at IS NULL`, unit-attached)
// `blocks` row whose reading unit has no `doc_blocks` row of its own. EPUB dual-writes both forms and PDF
// writes only `doc_blocks`, so both qualify; a Markdown-only Work (legacy `blocks`, no `doc_blocks`) does
// not and stays read-only, exposing no correction action. The predicate reads `work_meta.origin`/`entry_id`
// of the row it is evaluated over, so it composes into both the single-Work authorization gate and the
// Library listing projection without an N+1 per-Work query.
export const correctableImportedWorkSql: SQL<boolean> = sql<boolean>`(
  ${workMeta.origin} = 'imported'
  AND EXISTS (SELECT 1 FROM ${docBlocks} WHERE ${docBlocks.workEntryId} = ${workMeta.entryId})
  AND NOT EXISTS (
    SELECT 1 FROM ${blocks} legacy
    WHERE legacy.work_entry_id = ${workMeta.entryId}
      AND legacy.deleted_at IS NULL
      AND legacy.reading_unit_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${docBlocks}
        WHERE ${docBlocks.readingUnitEntryId} = legacy.reading_unit_entry_id
      )
  )
)`;

// The Work-level facts a correction editor payload is built from. Unlike the manual editor there is NO
// `personal_entries` join — imported content has no ownership facet (#762) — and `manualCorrectionsAt` is
// carried for display: the instant the Work was first hand-corrected, or null when still as-ingested.
// `contentRevision` is the Work-scoped optimistic-concurrency token (#703).
type CorrectableImportedWorkMeta = Readonly<{
  contentRevision: number;
  language: ImportedWorkDto["language"];
  manualCorrectionsAt: Date | null;
  title: string;
  workType: ImportedWorkDto["workType"];
}>;

// Verify a Work is a correctable imported Work and return its metadata, scoped by `origin = 'imported'`
// AND canonical-content eligibility. Returns `undefined` (→ 404) for an unknown id, a manual or authored
// Work, or an imported Work whose readable hierarchy is not fully canonical `doc_blocks`. No ownership is
// consulted: in v0 the current-user provider is the sole administrator for shared Library correction.
export async function findCorrectableImportedWork(
  db: DbClient,
  workEntryId: EntryId
): Promise<CorrectableImportedWorkMeta | undefined> {
  const [work] = await db
    .select({
      contentRevision: workMeta.contentRevision,
      language: workMeta.language,
      manualCorrectionsAt: workMeta.manualCorrectionsAt,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(workMeta)
    .where(and(eq(workMeta.entryId, workEntryId), correctableImportedWorkSql))
    .limit(1);

  return work;
}

// Build the correction editor DTO from a correctable imported Work's metadata, the opened section's id +
// document, and the whole Work's ordered section list. `revision` is the Work-scoped `content_revision`
// the editor echoes on save/add; `correctedAt` is the first-correction instant reported for display.
export function toImportedWorkDto(
  workEntryId: EntryId,
  work: CorrectableImportedWorkMeta,
  unitEntryId: string,
  document: DocumentNodeJSON,
  sections: ImportedWorkDto["sections"]
): ImportedWorkDto {
  return {
    correctedAt: work.manualCorrectionsAt === null ? null : work.manualCorrectionsAt.toISOString(),
    document,
    entryId: toEntryId(workEntryId),
    language: work.language,
    revision: work.contentRevision,
    sections: [...sections],
    title: work.title,
    unitEntryId,
    workType: work.workType
  };
}

// The correctable imported Work opened at its FIRST section — the section list the Outline is derived from
// plus that first section's reassembled document. Origin- and eligibility-scoped (see
// `findCorrectableImportedWork`): a non-imported or non-canonical Work returns `undefined` (→ 404). A
// published imported Work always has at least one section, so the first section always exists.
export async function loadImportedWorkForCorrection(
  db: DbClient,
  workEntryId: EntryId
): Promise<ImportedWorkDto | undefined> {
  const work = await findCorrectableImportedWork(db, workEntryId);

  if (work === undefined) {
    return undefined;
  }

  const sections = await loadManualWorkSections(db, workEntryId);
  const first = sections[0];
  /* v8 ignore start -- a published imported Work always has >= 1 section, so `first` is never undefined;
     the guard only narrows the type and its return is unreachable through the real routes. */
  if (first === undefined) {
    return undefined;
  }
  /* v8 ignore stop */

  const document = await loadManualWorkDocument(db, first.unitEntryId);
  return toImportedWorkDto(workEntryId, work, first.unitEntryId, document, sections);
}

// One section's canonical document, loaded on demand when the administrator navigates the Outline to a
// section other than the one the editor opened with (#762). Origin/eligibility-scoped like the parent
// Work, and the unit must belong to that Work — a forged or cross-work unit id returns `undefined` (→ 404).
export async function loadImportedWorkUnit(
  db: DbClient,
  workEntryId: EntryId,
  unitEntryId: EntryId
): Promise<ImportedWorkUnitDto | undefined> {
  const work = await findCorrectableImportedWork(db, workEntryId);

  if (work === undefined) {
    return undefined;
  }

  const [unit] = await db
    .select({ entryId: readingUnits.entryId })
    .from(readingUnits)
    .where(and(eq(readingUnits.entryId, unitEntryId), eq(readingUnits.workEntryId, workEntryId)))
    .limit(1);

  if (unit === undefined) {
    return undefined;
  }

  const document = await loadManualWorkDocument(db, unitEntryId);
  return { document, unitEntryId };
}
