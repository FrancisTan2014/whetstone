import {
  planWorkSectionInsertion,
  toEntryId,
  type BlockChangeSet,
  type EntryId,
  type WorkSectionPlacement
} from "@whetstone/domain";
import type { ImportedWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  insertEditableWorkSection,
  repartitionEditableWorkContent
} from "../content/editableWorkContent.js";
import { stampCorrectionMarkers } from "../content/workCorrectionMarkers.js";
import { claimWorkContentRevision } from "../content/workContentRevision.js";
import { normalizeManualWorkDocument } from "./manualWorkDocument.js";
import {
  correctableImportedWorkSql,
  findCorrectableImportedWork,
  toImportedWorkDto
} from "./importedWorkContentQueries.js";
import { loadManualWorkDocument, loadManualWorkSections } from "./manualWorkContentQueries.js";
import { readingUnits, workMeta } from "../../db/schema.js";

// The imported-Work correction editor's section writes are Library-owned commands, parallel to the manual
// editor's but with a DIFFERENT authority: imported content is shared, not owned, so there is no
// `personal_entries` guard and no owner chronology bump — the v0 current-user provider is the sole
// administrator (#762). Both commands claim the same Work-scoped revision fence (#703) the manual editor
// uses and drive the same origin-neutral block reconciliation (#696/#697); on top of that a correction
// records DURABLE correction evidence (`work_meta.manual_corrections_at` + `doc_blocks.corrected_at`) so a
// future replace/re-ingestion path can refuse to overwrite hand-corrected content. Real infrastructure (the
// DB, the clock, id generation) is injected so the commands stay deterministic and testable.
export type ImportedWorkContentDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// A correction save either lands (returning the reopened Work at a new revision with recomputed sections),
// is rejected because no correctable imported Work exists by that id or the target section is not part of
// it, or is refused because the sent revision is stale — another session saved in between, so overwriting
// it would silently lose that write. The command never mutates on a conflict.
export type CorrectImportedWorkContentResult =
  | Readonly<{ status: "corrected"; work: ImportedWorkDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "conflict" }>;

// Adding a section either lands (returning the Work opened at the NEW section with a new revision and the
// recomputed section list), is rejected because no correctable imported Work exists by that id, or is
// refused because the sent revision is stale. Same conflict semantics as a save.
export type AddImportedWorkSectionResult =
  | Readonly<{ status: "added"; work: ImportedWorkDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "invalid_placement" }>
  | Readonly<{ status: "conflict" }>;

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// The Work-level authorization gate shared by both commands: `origin = 'imported'` AND canonical-content
// eligibility (see `correctableImportedWorkSql`). `undefined` for a forged id, a manual/authored Work, or
// an imported Work whose readable hierarchy is not fully canonical `doc_blocks` — every one a 404 before
// any write. No ownership is consulted: shared Library content has no per-user claim in v0.
async function findCorrectableWork(tx: Transaction, workEntryId: EntryId): Promise<boolean> {
  const [work] = await tx
    .select({ entryId: workMeta.entryId })
    .from(workMeta)
    .where(and(eq(workMeta.entryId, workEntryId), correctableImportedWorkSql))
    .limit(1);

  return work !== undefined;
}

// Correct one section's canonical document through the shared editable-Work boundary, which preserves the
// id of every surviving block so notes, reading positions, links, Recitation ranges, cards, and review
// history anchored to an unchanged block stay valid across corrections. Scoped to `origin = 'imported'` AND
// canonical content, and the target section must belong to that Work: a forged id, a manual/authored Work,
// a non-canonical imported Work, or a cross-work section is rejected (404) before any write. The loaded
// `revision` (the Work's `content_revision`) must still be the stored one, or the correction is a conflict
// and nothing is written. In one transaction the command claims the revision, reconciles the blocks, and
// stamps the correction markers from the precise change set — an unchanged Save advances the revision but
// stamps no marker, so it never fabricates false correction evidence. The immutable source/hash and
// extraction evidence are untouched: correction only rewrites canonical block rows.
export async function correctImportedWorkContent(
  dependencies: ImportedWorkContentDependencies,
  workEntryId: EntryId,
  unitEntryId: EntryId,
  document: DocumentNodeJSON,
  revision: number
): Promise<CorrectImportedWorkContentResult> {
  const now = dependencies.now();

  const outcome = await dependencies.db.transaction(async (tx) => {
    if (!(await findCorrectableWork(tx, workEntryId))) {
      return { status: "not_found" as const };
    }

    const [unit] = await tx
      .select({ entryId: readingUnits.entryId })
      .from(readingUnits)
      .where(and(eq(readingUnits.entryId, unitEntryId), eq(readingUnits.workEntryId, workEntryId)))
      .limit(1);
    if (unit === undefined) {
      return { status: "not_found" as const };
    }

    const claimed = await claimWorkContentRevision(tx, workEntryId, revision);
    if (claimed === undefined) {
      return { status: "conflict" as const };
    }

    // Substitute the corrected section's draft into the Work's block stream and repartition the affected
    // span at heading boundaries, exactly as the manual editor does; the returned change set names the
    // precise inserted/changed/removed/moved blocks so the markers record real correction evidence only.
    const normalized = normalizeManualWorkDocument(document);
    const { activeUnitEntryId, changeSet } = await repartitionEditableWorkContent(tx, {
      createEntryId: dependencies.createEntryId,
      document: normalized,
      editedUnitEntryId: unitEntryId,
      workEntryId
    });
    await stampCorrectionMarkers(tx, workEntryId, changeSet, now);

    return { activeUnitEntryId, status: "corrected" as const };
  });

  if (outcome.status !== "corrected") {
    return outcome;
  }

  return {
    status: "corrected",
    work: await buildDto(dependencies.db, workEntryId, toEntryId(outcome.activeUnitEntryId))
  };
}

// Insert a sibling or child from the target's canonical first-heading branch and open it (#881). Imported
// insertion uses the same planner/writer as manual authoring, then stamps only the genuinely new blocks.
export async function addImportedWorkSection(
  dependencies: ImportedWorkContentDependencies,
  workEntryId: EntryId,
  targetUnitEntryId: EntryId,
  placement: WorkSectionPlacement,
  revision: number
): Promise<AddImportedWorkSectionResult> {
  const now = dependencies.now();

  const outcome = await dependencies.db.transaction(async (tx) => {
    if (!(await findCorrectableWork(tx, workEntryId))) {
      return { status: "not_found" as const };
    }

    const sections = await loadManualWorkSections(tx, workEntryId);
    const plan = planWorkSectionInsertion(sections, targetUnitEntryId, placement);
    if (plan.status === "target_not_found") {
      return { status: "not_found" as const };
    }
    if (plan.status === "invalid_placement") {
      return plan;
    }

    const claimed = await claimWorkContentRevision(tx, workEntryId, revision);
    if (claimed === undefined) {
      return { status: "conflict" as const };
    }

    const inserted = await insertEditableWorkSection(tx, {
      createEntryId: dependencies.createEntryId,
      headingLevel: plan.headingLevel,
      orderIndex: plan.orderIndex,
      workEntryId
    });
    // Adding a section inserts real new blocks, so the change set is exactly those insertions; stamping
    // records the Work marker (on the first section added) and `corrected_at` on each new block.
    const changeSet: BlockChangeSet = {
      changed: [],
      inserted: inserted.insertedBlockIds,
      moved: [],
      removed: []
    };
    await stampCorrectionMarkers(tx, workEntryId, changeSet, now);

    return { status: "added" as const, unitEntryId: inserted.unitEntryId };
  });

  if (outcome.status !== "added") {
    return outcome;
  }

  return {
    status: "added",
    work: await buildDto(dependencies.db, workEntryId, toEntryId(outcome.unitEntryId))
  };
}

// Reassemble the correction editor DTO after a committed write: the recomputed section list plus the opened
// section's stored document, at the newly-claimed content revision and current correction marker. Read with
// the DB client (not the transaction) so it reflects exactly what was committed. Correction never makes a
// Work ineligible (it only rewrites canonical `doc_blocks`, never adds legacy content), so the reload
// always finds it.
async function buildDto(
  db: DbClient,
  workEntryId: EntryId,
  unitEntryId: EntryId
): Promise<ImportedWorkDto> {
  const meta = await findCorrectableImportedWork(db, workEntryId);
  /* v8 ignore start -- a just-corrected Work is still a correctable imported Work (correction only rewrites
     canonical blocks), so `meta` is never undefined; the guard only narrows the type. */
  if (meta === undefined) {
    throw new Error("corrected imported Work vanished");
  }
  /* v8 ignore stop */

  const sections = await loadManualWorkSections(db, workEntryId);
  const document = await loadManualWorkDocument(db, unitEntryId);

  return toImportedWorkDto(workEntryId, meta, unitEntryId, document, sections);
}
