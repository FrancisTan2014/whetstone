import type { BlockType, DecomposedReadingUnit, EntryId } from "@whetstone/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, entries, entryLinks, readingPositions, readingUnits } from "../../db/schema.js";
import { insertInBatches } from "./insertBatching.js";

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type ReconcileInput = Readonly<{
  // One entry per new block, flattened in reading order (units in order, blocks in
  // order): the existing block id to preserve, or undefined for a genuinely new block.
  assignments: ReadonlyArray<string | undefined>;
  createEntryId: () => string;
  // Reading-unit entry ids that existed before this re-ingestion; replaced wholesale.
  oldUnitIds: ReadonlyArray<string>;
  // Existing block ids no new block matched; soft-deleted (kept for note-anchor validity).
  removedIds: ReadonlyArray<string>;
  units: ReadonlyArray<DecomposedReadingUnit>;
  workEntryId: EntryId;
}>;

type UnitEntryRow = { id: string; type: "reading_unit" };
type BlockEntryRow = { id: string; type: "block" };
type UnitRow = { entryId: string; orderIndex: number; title: string | null; workEntryId: EntryId };
type BlockRow = {
  blockType: BlockType;
  deletedAt: null;
  entryId: string;
  mdastJson: unknown;
  orderIndex: number;
  plaintext: string;
  readingUnitEntryId: string;
  workEntryId: EntryId;
};
type LinkRow = { fromEntryId: string; toEntryId: string; type: "contains" };
type PreservedUpdate = {
  blockType: BlockType;
  entryId: string;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
  unitId: string;
};

// Replace a work's reading units and blocks to match the freshly decomposed source,
// preserving stable ids per `assignments`. Matched blocks are updated in place and
// re-pointed to fresh units; new blocks are inserted; removed blocks are soft-deleted
// and detached so the old (now empty) unit entries can be deleted FK-safely. Runs
// inside the caller's transaction so re-ingestion is atomic.
export async function reconcileWorkBlocks(tx: Transaction, input: ReconcileInput): Promise<void> {
  const unitEntryRows: UnitEntryRow[] = [];
  const unitRows: UnitRow[] = [];
  const newBlockEntryRows: BlockEntryRow[] = [];
  const newBlockRows: BlockRow[] = [];
  const links: LinkRow[] = [];
  const preservedUpdates: PreservedUpdate[] = [];

  let flatIndex = 0;
  input.units.forEach((unit, unitIndex) => {
    const unitId = input.createEntryId();
    unitEntryRows.push({ id: unitId, type: "reading_unit" });
    unitRows.push({
      entryId: unitId,
      orderIndex: unitIndex,
      title: unit.title ?? null,
      workEntryId: input.workEntryId
    });
    links.push({ fromEntryId: input.workEntryId, toEntryId: unitId, type: "contains" });

    unit.blocks.forEach((block, blockIndex) => {
      const assigned = input.assignments[flatIndex];
      flatIndex += 1;
      const blockId = assigned ?? input.createEntryId();

      if (assigned === undefined) {
        newBlockEntryRows.push({ id: blockId, type: "block" });
        newBlockRows.push({
          blockType: block.blockType,
          deletedAt: null,
          entryId: blockId,
          mdastJson: block.mdast,
          orderIndex: blockIndex,
          plaintext: block.plaintext,
          readingUnitEntryId: unitId,
          workEntryId: input.workEntryId
        });
      } else {
        preservedUpdates.push({
          blockType: block.blockType,
          entryId: blockId,
          mdast: block.mdast,
          orderIndex: blockIndex,
          plaintext: block.plaintext,
          unitId
        });
      }

      links.push({ fromEntryId: unitId, toEntryId: blockId, type: "contains" });
    });
  });

  // Insert fresh unit/block entries (FK targets) before re-pointing preserved blocks.
  // Each bulk insert is batched so a large work stays within the DB bind-parameter limit.
  await insertInBatches(unitEntryRows, (batch) => tx.insert(entries).values(batch));
  await insertInBatches(newBlockEntryRows, (batch) => tx.insert(entries).values(batch));
  await insertInBatches(unitRows, (batch) => tx.insert(readingUnits).values(batch));
  await insertInBatches(newBlockRows, (batch) => tx.insert(blocks).values(batch));

  for (const update of preservedUpdates) {
    await tx
      .update(blocks)
      .set({
        blockType: update.blockType,
        deletedAt: null,
        mdastJson: update.mdast,
        orderIndex: update.orderIndex,
        plaintext: update.plaintext,
        readingUnitEntryId: update.unitId
      })
      .where(eq(blocks.entryId, update.entryId));
  }

  if (input.removedIds.length > 0) {
    await tx
      .update(blocks)
      .set({ deletedAt: new Date(), readingUnitEntryId: null })
      .where(inArray(blocks.entryId, [...input.removedIds]));
  }

  if (input.oldUnitIds.length > 0) {
    const oldUnitIds = [...input.oldUnitIds];
    // A saved reading position (created when the work is opened in the Reader) references one of
    // these old unit entries via `reading_positions.unit_entry_id` (NOT NULL, FK to entries). The
    // content is being fully replaced, so the position no longer maps to anything: clear the work's
    // positions before deleting the unit entries, otherwise that dangling FK rolls back the whole
    // re-ingestion (a 500). The reader simply resumes at the start next time.
    await tx.delete(readingPositions).where(eq(readingPositions.workEntryId, input.workEntryId));
    await tx.delete(entryLinks).where(inArray(entryLinks.fromEntryId, oldUnitIds));
    await tx
      .delete(entryLinks)
      .where(
        and(
          eq(entryLinks.fromEntryId, input.workEntryId),
          inArray(entryLinks.toEntryId, oldUnitIds)
        )
      );
    await tx.delete(readingUnits).where(inArray(readingUnits.entryId, oldUnitIds));
    await tx.delete(entries).where(inArray(entries.id, oldUnitIds));
  }

  await insertInBatches(links, (batch) => tx.insert(entryLinks).values(batch));
}
