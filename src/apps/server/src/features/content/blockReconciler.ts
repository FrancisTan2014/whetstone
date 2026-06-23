import type { BlockType, DecomposedReadingUnit, EntryId } from "@whetstone/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, entries, entryLinks, readingUnits } from "../../db/schema.js";

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
          readingUnitEntryId: unitId
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
  if (unitEntryRows.length > 0) {
    await tx.insert(entries).values(unitEntryRows);
  }
  if (newBlockEntryRows.length > 0) {
    await tx.insert(entries).values(newBlockEntryRows);
  }
  if (unitRows.length > 0) {
    await tx.insert(readingUnits).values(unitRows);
  }
  if (newBlockRows.length > 0) {
    await tx.insert(blocks).values(newBlockRows);
  }

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

  if (links.length > 0) {
    await tx.insert(entryLinks).values(links);
  }
}
