import { toEntryId, type EntryId } from "@whetstone/domain";
import type { BlockDto, ReadingUnitDto, WorkContentDto } from "@whetstone/contracts";
import { asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, readingUnits, workMeta } from "../../db/schema.js";

type ReadingUnitRow = Readonly<{
  entryId: string;
  orderIndex: number;
  title: string | null;
}>;

type BlockRow = Readonly<{
  blockType: BlockDto["blockType"];
  entryId: string;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
  readingUnitEntryId: string;
}>;

export async function workExists(db: DbClient, workEntryId: EntryId): Promise<boolean> {
  const rows = await db
    .select({ entryId: workMeta.entryId })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);

  return rows[0] !== undefined;
}

export async function loadWorkContent(db: DbClient, workEntryId: EntryId): Promise<WorkContentDto> {
  const unitRows = await db
    .select({
      entryId: readingUnits.entryId,
      orderIndex: readingUnits.orderIndex,
      title: readingUnits.title
    })
    .from(readingUnits)
    .where(eq(readingUnits.workEntryId, workEntryId))
    .orderBy(asc(readingUnits.orderIndex));

  const blockRows = await db
    .select({
      blockType: blocks.blockType,
      entryId: blocks.entryId,
      mdast: blocks.mdastJson,
      orderIndex: blocks.orderIndex,
      plaintext: blocks.plaintext,
      readingUnitEntryId: blocks.readingUnitEntryId
    })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .where(eq(readingUnits.workEntryId, workEntryId))
    .orderBy(asc(blocks.orderIndex));

  const readingUnitDtos = unitRows.map((unit) =>
    toReadingUnitDto(
      unit,
      blockRows.filter((block) => block.readingUnitEntryId === unit.entryId).map(toBlockDto)
    )
  );

  return { readingUnits: readingUnitDtos, workEntryId };
}

function toReadingUnitDto(
  unit: ReadingUnitRow,
  unitBlocks: ReadonlyArray<BlockDto>
): ReadingUnitDto {
  const base = {
    blocks: unitBlocks,
    entryId: toEntryId(unit.entryId),
    orderIndex: unit.orderIndex
  };

  return unit.title === null ? base : { ...base, title: unit.title };
}

function toBlockDto(block: BlockRow): BlockDto {
  return {
    blockType: block.blockType,
    entryId: toEntryId(block.entryId),
    mdast: block.mdast,
    orderIndex: block.orderIndex,
    plaintext: block.plaintext
  };
}
