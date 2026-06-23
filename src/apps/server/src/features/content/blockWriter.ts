import type { BlockType, DecomposedReadingUnit, EntryId } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, entries, entryLinks, readingUnits } from "../../db/schema.js";

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
export async function writeReadingUnits(
  tx: Transaction,
  input: WriteReadingUnitsInput
): Promise<void> {
  if (input.units.length === 0) {
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
  }[] = [];
  const linkRows: { fromEntryId: string; toEntryId: string; type: "contains" }[] = [];

  input.units.forEach((unit, unitIndex) => {
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
        readingUnitEntryId: unitEntryId
      });
      linkRows.push({ fromEntryId: unitEntryId, toEntryId: blockEntryId, type: "contains" });
    });
  });

  await tx.insert(entries).values(entryRows);
  await tx.insert(readingUnits).values(readingUnitRows);
  await tx.insert(blocks).values(blockRows);
  await tx.insert(entryLinks).values(linkRows);
}
