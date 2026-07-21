import { toEntryId, type EntryId } from "@whetstone/domain";
import type { ManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { docBlocks, personalEntries, readingUnits, workMeta } from "../../db/schema.js";

// The columns a manual Work's editor payload is built from. A manual Work is a `work_meta` row with
// `origin = 'manual'` that also carries the learner's `personal_entries` ownership facet (#695/#720).
// Origin is the authority discriminator: an authored Work also carries `personal_entries`, so the
// ownership join alone cannot tell owned writing from learner-curated Library content — the
// `origin = 'manual'` predicate keeps them apart, so this editor never opens an authored or imported Work.
type OwnedManualWorkRow = Readonly<{
  createdAt: Date;
  language: ManualWorkDto["language"];
  title: string;
  unitEntryId: string;
  updatedAt: Date;
  workType: ManualWorkDto["workType"];
}>;

// Load the owner's manual Work and its single reading unit, scoped by `origin = 'manual'` AND the owner
// `personal_entries` facet. Returns `undefined` (→ 404) for an unknown id, another user's Work, an
// imported Work, or an authored Work. Shared by the load query and the save command's authorization gate,
// so both reject non-owners and non-manual origins identically.
export async function findOwnedManualWork(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<OwnedManualWorkRow | undefined> {
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

// Reassemble a manual Work's canonical document from its ordered `doc_blocks` rows (each a top-level
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

// Build the editor DTO from an owned manual-Work row and its reassembled document. The `revision` is the
// owner's last-write timestamp (the optimistic-concurrency token the editor echoes on save).
export function toManualWorkDto(
  workEntryId: EntryId,
  owned: OwnedManualWorkRow,
  document: DocumentNodeJSON
): ManualWorkDto {
  return {
    createdAt: owned.createdAt.toISOString(),
    document,
    entryId: toEntryId(workEntryId),
    language: owned.language,
    revision: owned.updatedAt.toISOString(),
    title: owned.title,
    unitEntryId: owned.unitEntryId,
    updatedAt: owned.updatedAt.toISOString(),
    workType: owned.workType
  };
}

// The owner's manual Work with its reassembled canonical document — what the editor loads to edit and
// reopens after a save. Owner-scoped and origin-scoped (see `findOwnedManualWork`): a non-owner or a
// non-manual origin returns `undefined` (→ 404).
export async function loadManualWorkForEditing(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<ManualWorkDto | undefined> {
  const owned = await findOwnedManualWork(db, workEntryId, userId);

  if (owned === undefined) {
    return undefined;
  }

  const document = await loadManualWorkDocument(db, owned.unitEntryId);
  return toManualWorkDto(workEntryId, owned, document);
}
