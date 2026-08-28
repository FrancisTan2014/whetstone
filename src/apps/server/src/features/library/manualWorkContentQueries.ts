import { toEntryId, type EntryId } from "@whetstone/domain";
import type { ManualWorkDto, ManualWorkSectionDto, ManualWorkUnitDto } from "@whetstone/contracts";
import { documentBlockHeading, type DocumentNodeJSON } from "@whetstone/document";
import { and, asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { docBlocks, personalEntries, readingUnits, workMeta } from "../../db/schema.js";

type QueryClient = Pick<DbClient, "select">;

// The Work-level facts a manual Work's editor payload is built from. A manual Work is a `work_meta` row
// with `origin = 'manual'` that also carries the learner's `personal_entries` ownership facet (#695/#720).
// Origin is the authority discriminator: an authored Work also carries `personal_entries`, so the
// ownership join alone cannot tell owned writing from learner-curated Library content — the
// `origin = 'manual'` predicate keeps them apart, so this editor never opens an authored or imported Work.
// `contentRevision` is the Work-scoped optimistic-concurrency token (#703, `work_meta.content_revision`);
// `updatedAt` is the owner's chronology (`personal_entries.updated_at`), never a second revision truth.
type OwnedManualWorkMeta = Readonly<{
  contentRevision: number;
  createdAt: Date;
  language: ManualWorkDto["language"];
  title: string;
  updatedAt: Date;
  workType: ManualWorkDto["workType"];
}>;

// Verify a Work is the caller's manual Work and return its metadata, scoped by `origin = 'manual'` AND
// the owner `personal_entries` facet. Returns `undefined` (→ 404) for an unknown id, another user's
// Work, an imported Work, or an authored Work. Unlike the single-unit #720 gate this no longer joins one
// reading unit — a manual Work now has an ordered SET of section units (#697), loaded separately.
export async function findOwnedManualWork(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<OwnedManualWorkMeta | undefined> {
  const [owned] = await db
    .select({
      contentRevision: workMeta.contentRevision,
      createdAt: personalEntries.createdAt,
      language: workMeta.language,
      title: workMeta.title,
      updatedAt: personalEntries.updatedAt,
      workType: workMeta.workType
    })
    .from(workMeta)
    .innerJoin(personalEntries, eq(personalEntries.entryId, workMeta.entryId))
    .where(
      and(
        eq(workMeta.entryId, workEntryId),
        eq(workMeta.origin, "manual"),
        eq(personalEntries.userId, userId)
      )
    )
    .limit(1);

  return owned;
}

// The manual Work's ordered sections with each section's heading identity DERIVED from its first
// persisted block (#697) — never a stored, second copy. A section that starts at a heading contributes
// that heading's `level` (1-6) and text; a section whose first block is not a heading (only ever the
// leading pre-heading section) or an empty heading contributes neither, and the outline projection maps
// the absence to a root "Start" / an untitled label. Recomputed from the blocks on every read.
export async function loadManualWorkSections(
  db: QueryClient,
  workEntryId: EntryId
): Promise<ManualWorkSectionDto[]> {
  const unitRows = await db
    .select({ entryId: readingUnits.entryId, orderIndex: readingUnits.orderIndex })
    .from(readingUnits)
    .where(eq(readingUnits.workEntryId, workEntryId))
    .orderBy(asc(readingUnits.orderIndex));

  // Each section's first block (order index 0) is the one that decides its heading identity.
  const firstBlockRows = await db
    .select({ node: docBlocks.nodeJson, readingUnitEntryId: docBlocks.readingUnitEntryId })
    .from(docBlocks)
    .where(and(eq(docBlocks.workEntryId, workEntryId), eq(docBlocks.orderIndex, 0)));
  const firstBlockByUnit = new Map(
    firstBlockRows.map((row) => [row.readingUnitEntryId, row.node as DocumentNodeJSON])
  );

  return unitRows.map((unit) => {
    const firstBlock = firstBlockByUnit.get(unit.entryId);
    /* v8 ignore start -- every persisted section has an order-0 block (creation and save always write
       one), so `firstBlock` is never undefined here; the guard only satisfies the Map.get return type. */
    const heading = firstBlock === undefined ? undefined : documentBlockHeading(firstBlock);
    /* v8 ignore stop */

    return {
      orderIndex: unit.orderIndex,
      unitEntryId: unit.entryId,
      ...(heading === undefined ? {} : { headingLevel: heading.level }),
      ...(heading?.title === undefined ? {} : { title: heading.title })
    };
  });
}

// Reassemble one section's canonical document from its ordered `doc_blocks` rows (each a top-level
// node), so the editor loads the exact stored document and the reader renders it through the same PM
// pipeline as authored/imported content — no projection or conversion.
export async function loadManualWorkDocument(
  db: DbClient,
  unitEntryId: string
): Promise<DocumentNodeJSON> {
  const blockRows = await db
    .select({ node: docBlocks.nodeJson, orderIndex: docBlocks.orderIndex })
    .from(docBlocks)
    .where(eq(docBlocks.readingUnitEntryId, unitEntryId))
    .orderBy(asc(docBlocks.orderIndex));

  return {
    content: blockRows.map((row) => row.node as DocumentNodeJSON),
    type: "doc"
  };
}

// Build the editor DTO from an owned manual-Work's metadata, the opened section's id + document, and the
// whole Work's ordered section list. `revision` is the Work-scoped `content_revision` — the optimistic-
// concurrency token the editor echoes on save/add; `updatedAt` is the owner's chronology, reported for
// display only and never used to fence a write.
export function toManualWorkDto(
  workEntryId: EntryId,
  owned: OwnedManualWorkMeta,
  unitEntryId: string,
  document: DocumentNodeJSON,
  sections: ReadonlyArray<ManualWorkSectionDto>
): ManualWorkDto {
  return {
    createdAt: owned.createdAt.toISOString(),
    document,
    entryId: toEntryId(workEntryId),
    language: owned.language,
    revision: owned.contentRevision,
    sections: [...sections],
    title: owned.title,
    unitEntryId,
    updatedAt: owned.updatedAt.toISOString(),
    workType: owned.workType
  };
}

// The owner's manual Work opened at its FIRST section — the section list the Outline is derived from
// plus that first section's reassembled document. Owner-scoped and origin-scoped (see
// `findOwnedManualWork`): a non-owner or a non-manual origin returns `undefined` (→ 404). A manual Work
// always has at least one section (its creation seeds one), so the first section always exists.
export async function loadManualWorkForEditing(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<ManualWorkDto | undefined> {
  const owned = await findOwnedManualWork(db, workEntryId, userId);

  if (owned === undefined) {
    return undefined;
  }

  const sections = await loadManualWorkSections(db, workEntryId);
  const first = sections[0];
  /* v8 ignore start -- an owned manual Work always has >= 1 section (creation seeds one, and no path
     removes the last), so `first` is never undefined; the guard only narrows the type and its return is
     unreachable through the real routes. */
  if (first === undefined) {
    return undefined;
  }
  /* v8 ignore stop */

  const document = await loadManualWorkDocument(db, first.unitEntryId);
  return toManualWorkDto(workEntryId, owned, first.unitEntryId, document, sections);
}

// One section's canonical document, loaded on demand when the learner navigates the Outline to a section
// other than the one the editor opened with (#697). Owner/origin-scoped like the parent Work, and the
// unit must belong to that Work — a forged or cross-work unit id returns `undefined` (→ 404).
export async function loadManualWorkUnit(
  db: DbClient,
  workEntryId: EntryId,
  unitEntryId: EntryId,
  userId: string
): Promise<ManualWorkUnitDto | undefined> {
  const owned = await findOwnedManualWork(db, workEntryId, userId);

  if (owned === undefined) {
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
