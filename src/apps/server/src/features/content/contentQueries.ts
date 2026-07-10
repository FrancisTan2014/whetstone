import { toEntryId, type EntryId } from "@whetstone/domain";
import type {
  BlockDto,
  DocBlockDto,
  ReadingUnitContentDto,
  ReadingUnitDto,
  ReadingUnitStructureDto,
  TocEntryDto,
  WorkAnchorIndexDto,
  WorkContentDto,
  WorkStructureDto
} from "@whetstone/contracts";
import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { addressableBlocks } from "../../db/addressableBlocks.js";
import {
  blocks,
  docBlocks,
  readingUnits,
  tocEntries,
  workMeta,
  workSources
} from "../../db/schema.js";

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

  // An in-app authored Work (#576) keeps its canonical content only in PM `doc_blocks` and records no
  // provenance source, whereas an imported Markdown/EPUB Work always writes a `work_sources` row. That
  // provenance is the reliable authored-vs-imported signal — a source file is not, since a parsed
  // chapter may carry none.
  const authored = !(await workHasSource(db, workEntryId));

  const readingUnitDtos = unitRows.flatMap((unit) => {
    const unitBlocks = blockRows.filter((block) => block.readingUnitEntryId === unit.entryId);
    const unitDocBlocks = docBlockRows.filter((block) => block.readingUnitEntryId === unit.entryId);
    const hasRenderableDocBlock = unitDocBlocks.some((block) => block.type !== "unknown");

    // A reading unit surfaces when it has renderable content in the substrate that owns it: non-deleted
    // mdast blocks for an ingested Work, or — for an authored Work, whose content lives only in PM
    // `doc_blocks` — at least one non-`unknown` `doc_blocks` row. The `authored` gate keeps this fallback
    // to authored Works, so an imported chapter with no mdast blocks (an unknown-only chapter kept only
    // for its `unknown` PM nodes, #311, or an unstorable-figure-only chapter) stays excluded exactly as
    // before. A unit with neither has nothing the reader can render.
    const surfaces = unitBlocks.length > 0 || (authored && hasRenderableDocBlock);
    return surfaces
      ? [toReadingUnitDto(unit, unitBlocks.map(toBlockDto), unitDocBlocks.map(toDocBlockDto))]
      : [];
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
      entryId: readingUnits.entryId,
      // A unit carries substantive text when any non-figure block has non-whitespace plaintext; a
      // cover/plate unit of only figure blocks (or empty text) is false. `bool_or` over zero blocks is
      // null (a PM-only authored unit), so it is only trusted when the unit has mdast blocks below.
      hasSubstantiveMdast: sql<boolean>`bool_or(${blocks.blockType} <> 'figure' and btrim(${blocks.plaintext}) <> '')`,
      mdastCount: count(blocks.entryId),
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

  // Renderable PM `doc_blocks` per unit (#576): an authored Work's canonical content lives only in
  // `doc_blocks`, so a unit with no mdast blocks still surfaces when it has non-`unknown` PM content.
  // `ne(type, 'unknown')` drops the `unknown` PM nodes an unknown-only EPUB chapter (#311) persists.
  const docRows = await db
    .select({
      docCount: count(docBlocks.id),
      hasSubstantiveDoc: sql<boolean>`bool_or(btrim(${docBlocks.plaintext}) <> '')`,
      readingUnitEntryId: docBlocks.readingUnitEntryId
    })
    .from(docBlocks)
    .where(and(eq(docBlocks.workEntryId, workEntryId), ne(docBlocks.type, "unknown")))
    .groupBy(docBlocks.readingUnitEntryId);
  // The `doc_blocks` fallback is scoped to authored Works via their absent provenance (`work_sources`),
  // the reliable authored-vs-imported signal — so for an imported Work `docByUnit` stays empty and its
  // no-mdast chapters (unknown-only or unstorable-figure-only) are excluded exactly as before.
  const authored = !(await workHasSource(db, workEntryId));
  const docByUnit = authored
    ? new Map(docRows.map((row) => [row.readingUnitEntryId, row]))
    : new Map<string, (typeof docRows)[number]>();

  // A unit is readable when it has content in the substrate that owns it. Mdast is authoritative for
  // count and substantiveness when present (EPUB/Markdown behavior unchanged). With no mdast, only an
  // authored unit surfaces (via `docByUnit`); an imported chapter with no mdast — an unknown-only or
  // unstorable-figure-only EPUB chapter — is absent from `docByUnit` and excluded.
  const structureUnits = rows.flatMap((row) => {
    if (row.mdastCount > 0) {
      return [
        {
          blockCount: row.mdastCount,
          entryId: row.entryId,
          hasSubstantiveText: row.hasSubstantiveMdast,
          orderIndex: row.orderIndex,
          sourceFile: row.sourceFile,
          title: row.title
        }
      ];
    }
    const doc = docByUnit.get(row.entryId);
    if (doc === undefined) {
      return [];
    }
    return [
      {
        blockCount: doc.docCount,
        entryId: row.entryId,
        hasSubstantiveText: doc.hasSubstantiveDoc,
        orderIndex: row.orderIndex,
        sourceFile: row.sourceFile,
        title: row.title
      }
    ];
  });
  const tableOfContents = await loadTableOfContents(db, workEntryId, structureUnits);

  return {
    readingUnits: structureUnits.map(toStructureDto),
    workEntryId,
    // Additive nav-derived TOC (#379): present only for a work with an authored nav; omitted (never
    // an empty array) otherwise, so the reader falls back to the flat reading-unit list.
    ...(tableOfContents.length === 0 ? {} : { tableOfContents })
  };
}

// The work's authored table of contents (#379): its persisted `toc_entries` in pre-order, each with
// its target reading unit resolved from the entry's source-file identity. `targetUnitEntryId` is the
// navigable unit whose `source_file` matches the entry's `target_source_file` (the first, matching the
// reader's top-to-bottom order) — omitted when the entry has no source file or its file has no
// navigable unit, so the reader no-ops that selection. Only units the reader actually lists (those
// with renderable blocks) are eligible targets, so a resolved entry always opens a real unit.
async function loadTableOfContents(
  db: DbClient,
  workEntryId: EntryId,
  structureUnits: ReadonlyArray<{ entryId: string; sourceFile: string | null }>
): Promise<ReadonlyArray<TocEntryDto>> {
  const rows = await db
    .select({
      depth: tocEntries.depth,
      entryId: tocEntries.entryId,
      label: tocEntries.label,
      orderIndex: tocEntries.orderIndex,
      parentEntryId: tocEntries.parentEntryId,
      targetAnchor: tocEntries.targetAnchor,
      targetSourceFile: tocEntries.targetSourceFile
    })
    .from(tocEntries)
    .where(eq(tocEntries.workEntryId, workEntryId))
    .orderBy(asc(tocEntries.orderIndex));

  const unitBySourceFile = new Map<string, string>();
  for (const unit of structureUnits) {
    if (unit.sourceFile !== null && !unitBySourceFile.has(unit.sourceFile)) {
      unitBySourceFile.set(unit.sourceFile, unit.entryId);
    }
  }

  return rows.map((row) => toTocEntryDto(row, unitBySourceFile));
}

function toTocEntryDto(
  row: Readonly<{
    depth: number;
    entryId: string;
    label: string;
    orderIndex: number;
    parentEntryId: string | null;
    targetAnchor: string | null;
    targetSourceFile: string | null;
  }>,
  unitBySourceFile: ReadonlyMap<string, string>
): TocEntryDto {
  const targetUnitEntryId =
    row.targetSourceFile === null ? undefined : unitBySourceFile.get(row.targetSourceFile);

  return {
    depth: row.depth,
    entryId: row.entryId,
    label: row.label,
    orderIndex: row.orderIndex,
    ...(row.parentEntryId === null ? {} : { parentEntryId: row.parentEntryId }),
    ...(targetUnitEntryId === undefined ? {} : { targetUnitEntryId }),
    ...(row.targetAnchor === null ? {} : { targetAnchor: row.targetAnchor })
  };
}

function toStructureDto(
  unit: ReadingUnitRow & {
    blockCount: number;
    hasSubstantiveText: boolean;
    sourceFile: string | null;
  }
): ReadingUnitStructureDto {
  const base = {
    blockCount: unit.blockCount,
    entryId: toEntryId(unit.entryId),
    hasSubstantiveText: unit.hasSubstantiveText,
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

// The work's anchor index: every id-bearing source element inside a PM `doc_blocks` block, paired
// with its owning unit's `source_file`, so the reader can build a work-scoped resolver that jumps a
// cross-reference to the exact element it points at (#366, #550). Each block's complete `anchors` map
// is flattened — one index entry per `{ anchor, nodeId }` — so a reference to a target nested inside a
// container block resolves too (previously only the block's own top-level id survived, ~72% of xrefs
// were dead). Keyed by (source_file, anchor) at the consumer, so the same anchor id reused in two
// source files yields two distinct, non-colliding entries. Reading order is preserved (block
// order, then in-block pre-order) so first-wins in the resolver stays correct.
export async function loadWorkAnchorIndex(
  db: DbClient,
  workEntryId: EntryId
): Promise<WorkAnchorIndexDto> {
  const rows = await db
    .select({
      anchors: docBlocks.anchors,
      blockEntryId: docBlocks.id,
      sourceFile: readingUnits.sourceFile,
      unitEntryId: docBlocks.readingUnitEntryId
    })
    .from(docBlocks)
    .innerJoin(readingUnits, eq(docBlocks.readingUnitEntryId, readingUnits.entryId))
    .where(eq(docBlocks.workEntryId, workEntryId))
    .orderBy(asc(docBlocks.orderIndex));

  const anchors = rows.flatMap((row) =>
    (row.anchors as ReadonlyArray<{ anchor: string; nodeId: string }>).map((entry) => ({
      anchor: entry.anchor,
      blockEntryId: row.blockEntryId,
      nodeId: entry.nodeId,
      sourceFile: row.sourceFile,
      unitEntryId: row.unitEntryId
    }))
  );

  return { anchors, workEntryId };
}
