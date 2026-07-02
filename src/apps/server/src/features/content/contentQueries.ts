import { toEntryId, type EntryId } from "@whetstone/domain";
import type {
  BlockDto,
  DocBlockDto,
  ReadingUnitContentDto,
  ReadingUnitDto,
  ReadingUnitStructureDto,
  WorkAnchorEntryDto,
  WorkAnchorIndexDto,
  WorkContentDto,
  WorkStructureDto
} from "@whetstone/contracts";
import { and, asc, count, eq, isNotNull, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { addressableBlocks } from "../../db/addressableBlocks.js";
import { blocks, docBlocks, readingUnits, workMeta, workSources } from "../../db/schema.js";

type ReadingUnitRow = Readonly<{
  entryId: string;
  orderIndex: number;
  title: string | null;
}>;

type BlockRow = Readonly<{
  alt: string | null;
  anchorId: string | null;
  backlinkAnchorId: string | null;
  blockType: BlockDto["blockType"];
  entryId: string;
  imageResourceId: string | null;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
  readingUnitEntryId: string | null;
}>;

type DocBlockRow = Readonly<{
  entryId: string;
  node: unknown;
  orderIndex: number;
  readingUnitEntryId: string;
  type: string;
}>;

// The block columns a BlockDto is built from, shared by the whole-work and per-unit queries.
const blockColumns = {
  alt: blocks.alt,
  anchorId: blocks.anchorId,
  backlinkAnchorId: blocks.backlinkAnchorId,
  blockType: blocks.blockType,
  entryId: blocks.entryId,
  imageResourceId: blocks.imageResourceId,
  mdast: blocks.mdastJson,
  orderIndex: blocks.orderIndex,
  plaintext: blocks.plaintext,
  readingUnitEntryId: blocks.readingUnitEntryId
} as const;

// The PM `doc_blocks` columns a DocBlockDto is built from (#312): the stable PM node id, the node
// JSON the reader renders via `@tiptap/static-renderer`, and ordering, shared by both content queries.
const docBlockColumns = {
  entryId: docBlocks.id,
  node: docBlocks.nodeJson,
  orderIndex: docBlocks.orderIndex,
  readingUnitEntryId: docBlocks.readingUnitEntryId,
  type: docBlocks.type
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

  const docBlockRows = await db
    .select(docBlockColumns)
    .from(docBlocks)
    .innerJoin(readingUnits, eq(docBlocks.readingUnitEntryId, readingUnits.entryId))
    .where(eq(readingUnits.workEntryId, workEntryId))
    .orderBy(asc(docBlocks.orderIndex));

  const readingUnitDtos = unitRows.flatMap((unit) => {
    const unitBlocks = blockRows.filter((block) => block.readingUnitEntryId === unit.entryId);
    const unitDocBlocks = docBlockRows.filter((block) => block.readingUnitEntryId === unit.entryId);

    // A reading unit with no non-deleted mdast blocks — an unknown-only / PM-only chapter (#311,
    // persisted so its `doc_blocks` can reference the unit) or a unit whose blocks were all
    // soft-deleted — has nothing the reader can render, so it is excluded here. Every readable EPUB
    // chapter carries mdast blocks, so all real chapters surface and render via their `doc_blocks`.
    return unitBlocks.length === 0
      ? []
      : [toReadingUnitDto(unit, unitBlocks.map(toBlockDto), unitDocBlocks.map(toDocBlockDto))];
  });

  return { readingUnits: readingUnitDtos, workEntryId };
}

function toReadingUnitDto(
  unit: ReadingUnitRow,
  unitBlocks: ReadonlyArray<BlockDto>,
  unitDocBlocks: ReadonlyArray<DocBlockDto>
): ReadingUnitDto {
  const base = {
    blocks: unitBlocks,
    docBlocks: unitDocBlocks,
    entryId: toEntryId(unit.entryId),
    orderIndex: unit.orderIndex
  };

  return unit.title === null ? base : { ...base, title: unit.title };
}

function toDocBlockDto(block: DocBlockRow): DocBlockDto {
  return {
    entryId: toEntryId(block.entryId),
    node: block.node,
    orderIndex: block.orderIndex,
    type: block.type
  };
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
  const withAnchor = block.anchorId === null ? withAlt : { ...withAlt, anchorId: block.anchorId };

  return block.backlinkAnchorId === null
    ? withAnchor
    : { ...withAnchor, backlinkAnchorId: block.backlinkAnchorId };
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
      sourceFile: readingUnits.sourceFile,
      title: readingUnits.title
    })
    .from(readingUnits)
    .leftJoin(
      blocks,
      and(eq(blocks.readingUnitEntryId, readingUnits.entryId), isNull(blocks.deletedAt))
    )
    .where(eq(readingUnits.workEntryId, workEntryId))
    .groupBy(
      readingUnits.entryId,
      readingUnits.orderIndex,
      readingUnits.sourceFile,
      readingUnits.title
    )
    .orderBy(asc(readingUnits.orderIndex));

  return {
    // Exclude units with no renderable mdast blocks (an unknown-only / PM-only chapter persisted for
    // its `doc_blocks`, or a unit whose blocks were all soft-deleted); the mdast reader shows only
    // units with content until #312 swaps it to the PM block rows (mirrors loadWorkContent).
    readingUnits: rows.filter((row) => row.blockCount > 0).map(toStructureDto),
    workEntryId
  };
}

function toStructureDto(
  unit: ReadingUnitRow & { blockCount: number; sourceFile: string | null }
): ReadingUnitStructureDto {
  const base = {
    blockCount: unit.blockCount,
    entryId: toEntryId(unit.entryId),
    orderIndex: unit.orderIndex
  };
  const withTitle = unit.title === null ? base : { ...base, title: unit.title };

  return unit.sourceFile === null ? withTitle : { ...withTitle, sourceFile: unit.sourceFile };
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
      sourceFile: readingUnits.sourceFile,
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

  const docBlockRows = await db
    .select(docBlockColumns)
    .from(docBlocks)
    .where(eq(docBlocks.readingUnitEntryId, unitEntryId))
    .orderBy(asc(docBlocks.orderIndex));

  const base = {
    blocks: blockRows.map(toBlockDto),
    docBlocks: docBlockRows.map(toDocBlockDto),
    entryId: toEntryId(unit.entryId),
    orderIndex: unit.orderIndex
  };
  const withTitle = unit.title === null ? base : { ...base, title: unit.title };

  return unit.sourceFile === null ? withTitle : { ...withTitle, sourceFile: unit.sourceFile };
}

// The reading unit owning an addressable block within the work, or `undefined` when the block does
// not exist, is soft-deleted/detached, or is not part of the work. The block is resolved over both
// substrates (legacy mdast `blocks` and PM `doc_blocks`) so a jump / scroll-to-block / reading-position
// restore keyed on a PM-rendered block id resolves its unit too (#312).
export async function locateBlockUnit(
  db: DbClient,
  workEntryId: EntryId,
  blockEntryId: EntryId
): Promise<EntryId | undefined> {
  const addressable = addressableBlocks(db);
  const rows = await db
    .select({ unitEntryId: readingUnits.entryId })
    .from(addressable)
    .innerJoin(readingUnits, eq(addressable.readingUnitEntryId, readingUnits.entryId))
    .where(
      and(
        eq(addressable.entryId, blockEntryId),
        eq(addressable.workEntryId, workEntryId),
        isNull(addressable.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];

  // The inner join drops soft-deleted/detached blocks (null reading-unit id), so a row here always
  // carries a real owning unit.
  return row === undefined ? undefined : toEntryId(row.unitEntryId);
}

// The work's anchor index: every PM `doc_blocks` block that carries a source-HTML id (`anchor_id`),
// paired with its owning unit's `source_file`, so the reader can build a work-scoped resolver that
// jumps a cross-reference to another unit (#366). Keyed by (source_file, anchor) at the consumer, so
// the same anchor id reused in two source files yields two distinct, non-colliding entries. Only PM
// `doc_blocks` carry an ingest-captured `anchor_id`, so the legacy mdast `blocks` are not unioned in
// here (their `blocks.anchor_id` served the #252 same-unit path over the DOM, not this index).
export async function loadWorkAnchorIndex(
  db: DbClient,
  workEntryId: EntryId
): Promise<WorkAnchorIndexDto> {
  const rows = await db
    .select({
      anchor: docBlocks.anchorId,
      blockEntryId: docBlocks.id,
      sourceFile: readingUnits.sourceFile,
      unitEntryId: docBlocks.readingUnitEntryId
    })
    .from(docBlocks)
    .innerJoin(readingUnits, eq(docBlocks.readingUnitEntryId, readingUnits.entryId))
    .where(and(eq(docBlocks.workEntryId, workEntryId), isNotNull(docBlocks.anchorId)))
    .orderBy(asc(docBlocks.orderIndex));

  return { anchors: rows.map(toAnchorEntryDto), workEntryId };
}

function toAnchorEntryDto(row: {
  anchor: string | null;
  blockEntryId: string;
  sourceFile: string | null;
  unitEntryId: string;
}): WorkAnchorEntryDto {
  return {
    // The `IS NOT NULL` filter guarantees a string `anchor`; read it through a cast rather than a
    // null-coalesce whose fallback branch could never run (keeps branch coverage exact).
    anchor: row.anchor as string,
    blockEntryId: row.blockEntryId,
    sourceFile: row.sourceFile,
    unitEntryId: row.unitEntryId
  };
}
