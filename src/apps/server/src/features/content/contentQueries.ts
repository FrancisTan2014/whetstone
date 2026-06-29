import { toEntryId, type EntryId } from "@whetstone/domain";
import type {
  BlockDto,
  ReadingUnitContentDto,
  ReadingUnitDto,
  ReadingUnitStructureDto,
  WorkContentDto,
  WorkStructureDto
} from "@whetstone/contracts";
import { and, asc, count, eq, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, readingUnits, workMeta, workSources } from "../../db/schema.js";

type ReadingUnitRow = Readonly<{
  entryId: string;
  orderIndex: number;
  title: string | null;
}>;

type BlockRow = Readonly<{
  alt: string | null;
  anchorId: string | null;
  blockType: BlockDto["blockType"];
  entryId: string;
  imageResourceId: string | null;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
  readingUnitEntryId: string | null;
}>;

// The block columns a BlockDto is built from, shared by the whole-work and per-unit queries.
const blockColumns = {
  alt: blocks.alt,
  anchorId: blocks.anchorId,
  blockType: blocks.blockType,
  entryId: blocks.entryId,
  imageResourceId: blocks.imageResourceId,
  mdast: blocks.mdastJson,
  orderIndex: blocks.orderIndex,
  plaintext: blocks.plaintext,
  readingUnitEntryId: blocks.readingUnitEntryId
} as const;

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
    .select(blockColumns)
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
  const withAlt = block.alt === null ? withImage : { ...withImage, alt: block.alt };

  return block.anchorId === null ? withAlt : { ...withAlt, anchorId: block.anchorId };
}

// A work's lightweight structure: ordered reading units with a non-deleted block count but no
// block content, so a lazy-loading reader can render the outline without shipping every block.
export async function loadWorkStructure(
  db: DbClient,
  workEntryId: EntryId
): Promise<WorkStructureDto> {
  const rows = await db
    .select({
      blockCount: count(blocks.entryId),
      entryId: readingUnits.entryId,
      orderIndex: readingUnits.orderIndex,
      title: readingUnits.title
    })
    .from(readingUnits)
    .leftJoin(
      blocks,
      and(eq(blocks.readingUnitEntryId, readingUnits.entryId), isNull(blocks.deletedAt))
    )
    .where(eq(readingUnits.workEntryId, workEntryId))
    .groupBy(readingUnits.entryId, readingUnits.orderIndex, readingUnits.title)
    .orderBy(asc(readingUnits.orderIndex));

  return {
    readingUnits: rows.map((row) => toStructureDto(row, row.blockCount)),
    workEntryId
  };
}

function toStructureDto(unit: ReadingUnitRow, blockCount: number): ReadingUnitStructureDto {
  const base = { blockCount, entryId: toEntryId(unit.entryId), orderIndex: unit.orderIndex };

  return unit.title === null ? base : { ...base, title: unit.title };
}

// One reading unit's content on demand, or `undefined` when the unit does not exist or is not part
// of the work. Returns the same ordered, non-deleted blocks the whole-work query would.
export async function loadReadingUnitContent(
  db: DbClient,
  workEntryId: EntryId,
  unitEntryId: EntryId
): Promise<ReadingUnitContentDto | undefined> {
  const unitRows = await db
    .select({
      entryId: readingUnits.entryId,
      orderIndex: readingUnits.orderIndex,
      title: readingUnits.title
    })
    .from(readingUnits)
    .where(and(eq(readingUnits.entryId, unitEntryId), eq(readingUnits.workEntryId, workEntryId)))
    .limit(1);
  const unit = unitRows[0];

  if (unit === undefined) {
    return undefined;
  }

  const blockRows = await db
    .select(blockColumns)
    .from(blocks)
    .where(and(eq(blocks.readingUnitEntryId, unitEntryId), isNull(blocks.deletedAt)))
    .orderBy(asc(blocks.orderIndex));

  const base = {
    blocks: blockRows.map(toBlockDto),
    entryId: toEntryId(unit.entryId),
    orderIndex: unit.orderIndex
  };

  return unit.title === null ? base : { ...base, title: unit.title };
}

// The reading unit owning a non-deleted block within the work, or `undefined` when the block does
// not exist, is soft-deleted/detached, or is not part of the work.
export async function locateBlockUnit(
  db: DbClient,
  workEntryId: EntryId,
  blockEntryId: EntryId
): Promise<EntryId | undefined> {
  const rows = await db
    .select({ unitEntryId: readingUnits.entryId })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .where(
      and(
        eq(blocks.entryId, blockEntryId),
        eq(blocks.workEntryId, workEntryId),
        isNull(blocks.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];

  // The inner join drops soft-deleted/detached blocks (null reading-unit id), so a row here always
  // carries a real owning unit.
  return row === undefined ? undefined : toEntryId(row.unitEntryId);
}
