import type { BlockType, DecomposedReadingUnit, EntryId } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, entries, entryLinks, readingUnits } from "../../db/schema.js";
import { insertInBatches } from "./insertBatching.js";

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type WriteReadingUnitsInput = Readonly<{
  createEntryId: () => string;
  startOrder: number;
  units: ReadonlyArray<DecomposedReadingUnit>;
  workEntryId: EntryId;
}>;

// Persist decomposed reading units and their blocks for a work, in a single batch,
// continuing the work's reading-unit ordering from `startOrder`. Shared by every
// format adapter (Markdown, EPUB) so block/link/entry creation has one owner.
// Reading units that decompose to zero supported blocks (e.g. an EPUB image-only or
// empty title page) carry no readable content, so they are skipped entirely rather
// than persisted as empty units or sent to an empty `values()` insert.
export async function writeReadingUnits(
  tx: Transaction,
  input: WriteReadingUnitsInput
): Promise<void> {
  const units = input.units.filter((unit) => unit.blocks.length > 0);

  if (units.length === 0) {
    return;
  }

  const entryRows: { id: string; type: "reading_unit" | "block" }[] = [];
  const readingUnitRows: {
    entryId: string;
    orderIndex: number;
    title: string | null;
    workEntryId: EntryId;
  }[] = [];
  const blockRows: {
    blockType: BlockType;
    entryId: string;
    mdastJson: unknown;
    orderIndex: number;
    plaintext: string;
    readingUnitEntryId: string;
    workEntryId: EntryId;
  }[] = [];
  const linkRows: { fromEntryId: string; toEntryId: string; type: "contains" }[] = [];

  units.forEach((unit, unitIndex) => {
    const unitEntryId = input.createEntryId();
    entryRows.push({ id: unitEntryId, type: "reading_unit" });
    readingUnitRows.push({
      entryId: unitEntryId,
      orderIndex: input.startOrder + unitIndex,
      title: unit.title ?? null,
      workEntryId: input.workEntryId
    });
    linkRows.push({ fromEntryId: input.workEntryId, toEntryId: unitEntryId, type: "contains" });

    unit.blocks.forEach((block, blockIndex) => {
      const blockEntryId = input.createEntryId();
      entryRows.push({ id: blockEntryId, type: "block" });
      blockRows.push({
        blockType: block.blockType,
        entryId: blockEntryId,
        mdastJson: block.mdast,
        orderIndex: blockIndex,
        plaintext: block.plaintext,
        readingUnitEntryId: unitEntryId,
        workEntryId: input.workEntryId
      });
      linkRows.push({ fromEntryId: unitEntryId, toEntryId: blockEntryId, type: "contains" });
    });
  });

  // Batched so a large work (thousands of blocks) never exceeds the DB's bind-parameter
  // limit in a single statement, which would silently roll back the whole transaction.
  await insertInBatches(entryRows, (batch) => tx.insert(entries).values(batch));
  await insertInBatches(readingUnitRows, (batch) => tx.insert(readingUnits).values(batch));
  await insertInBatches(blockRows, (batch) => tx.insert(blocks).values(batch));
  await insertInBatches(linkRows, (batch) => tx.insert(entryLinks).values(batch));
}
