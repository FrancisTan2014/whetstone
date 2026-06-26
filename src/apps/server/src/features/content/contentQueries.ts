import { toEntryId, type EntryId } from "@whetstone/domain";
import type { BlockDto, ReadingUnitDto, WorkContentDto } from "@whetstone/contracts";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, readingUnits, workMeta, workSources } from "../../db/schema.js";

type ReadingUnitRow = Readonly<{
  entryId: string;
  orderIndex: number;
  title: string | null;
}>;

type BlockRow = Readonly<{
  alt: string | null;
  blockType: BlockDto["blockType"];
  entryId: string;
  imageResourceId: string | null;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
  readingUnitEntryId: string | null;
}>;

export async function workExists(db: DbClient, workEntryId: EntryId): Promise<boolean> {
  const rows = await db
    .select({ entryId: workMeta.entryId })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);

  return rows[0] !== undefined;
}

// Whether the work has ever been ingested. Used to distinguish a first ingestion
// (always proceeds, recording provenance) from an idempotent re-ingestion no-op.
export async function workHasSource(db: DbClient, workEntryId: EntryId): Promise<boolean> {
  const rows = await db
    .select({ id: workSources.id })
    .from(workSources)
    .where(eq(workSources.workEntryId, workEntryId))
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
      alt: blocks.alt,
      blockType: blocks.blockType,
      entryId: blocks.entryId,
      imageResourceId: blocks.imageResourceId,
      mdast: blocks.mdastJson,
      orderIndex: blocks.orderIndex,
      plaintext: blocks.plaintext,
      readingUnitEntryId: blocks.readingUnitEntryId
    })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .where(and(eq(readingUnits.workEntryId, workEntryId), isNull(blocks.deletedAt)))
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
  const base: BlockDto = {
    blockType: block.blockType,
    entryId: toEntryId(block.entryId),
    mdast: block.mdast,
    orderIndex: block.orderIndex,
    plaintext: block.plaintext
  };
  const withImage =
    block.imageResourceId === null ? base : { ...base, imageResourceId: block.imageResourceId };

  return block.alt === null ? withImage : { ...withImage, alt: block.alt };
}
