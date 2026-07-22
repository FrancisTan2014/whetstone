import { buildHeadingOutline, toEntryId, type EntryId } from "@whetstone/domain";
import {
  documentBlockHeading,
  type DocumentBlockHeading,
  type DocumentNodeJSON
} from "@whetstone/document";
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
  sourceFile: string | null;
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

// The origin of a Work, or `undefined` when no such Work exists. Markdown/PDF ingestion consults this to
// refuse writing legacy Markdown into a `manual`-origin Work, whose content is a canonical ProseMirror
// document edited only through the manual-Work editor (#720) — mixing the two formats would corrupt it.
export async function loadWorkOrigin(
  db: DbClient,
  workEntryId: EntryId
): Promise<"imported" | "manual" | "authored" | undefined> {
  const rows = await db
    .select({ origin: workMeta.origin })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);

  return rows[0]?.origin;
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
      sourceFile: readingUnits.sourceFile,
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
    const hasRenderableDocBlock = unitDocBlocks.some((block) => block.type !== "unknown");

    // A reading unit surfaces when it has renderable content in the substrate that owns it: non-deleted
    // mdast blocks for a Markdown/EPUB chapter, or — for a unit whose content lives only in PM
    // `doc_blocks` (an authored/manual Work #576, or a canonical PDF import #702) — at least one
    // non-`unknown` `doc_blocks` row. The gate is the unit's own `source_file`: a per-unit source file
    // (an EPUB spine item) is an mdast chapter and never falls back to `doc_blocks`, so an EPUB chapter
    // with no mdast blocks (an unknown-only chapter kept only for its `unknown` PM nodes, #311, or an
    // unstorable-figure-only chapter) stays excluded exactly as before, while a null-`source_file` unit
    // (Markdown, authored, PDF) may surface its PM content. A unit with neither has nothing to render.
    const surfaces = unitBlocks.length > 0 || (unit.sourceFile === null && hasRenderableDocBlock);
    return surfaces
      ? [
          toReadingUnitDto(
            unit,
            unitBlocks.map(toBlockDto),
            unitDocBlocks.map(toDocBlockDto),
            firstBlockHeadingLevel(unit.sourceFile, unitBlocks)
          )
        ]
      : [];
  });

  return { readingUnits: readingUnitDtos, workEntryId };
}

// The Markdown heading level (mdast heading depth) that starts a unit, or `undefined` when the unit
// is not the start of a section the heading outline should list: a unit with a per-unit source file
// (EPUB, whose hierarchy is its authored nav, not derived headings), or a unit whose first block is
// not a heading (the leading run of content before a work's first heading). The first block is the one
// at the lowest order index, which the block query returns first for the unit (#680).
function firstBlockHeadingLevel(
  sourceFile: string | null,
  unitBlocks: ReadonlyArray<BlockRow>
): number | undefined {
  if (sourceFile !== null) {
    return undefined;
  }
  const first = unitBlocks[0];
  if (first === undefined || first.blockType !== "heading") {
    return undefined;
  }
  return mdastHeadingDepth(first.mdast);
}

// The `depth` of an mdast heading node (1-6), read defensively from the persisted node JSON; absent
// when the node is not a heading with a numeric depth.
function mdastHeadingDepth(mdast: unknown): number | undefined {
  const depth = (mdast as { depth?: unknown } | null | undefined)?.depth;
  return typeof depth === "number" ? depth : undefined;
}

// The heading each null-`source_file` unit starts at, derived from its FIRST persisted PM block (order
// index 0) — the manual-Work Reader-parity path (#697), shared by a canonical PDF import (#702). A unit
// whose content lives only in `doc_blocks` (a manual Work, or a PDF import) has a null
// `reading_units.title`, so — unlike a Markdown unit whose outline heading comes from its first mdast
// heading — its outline heading level AND title must come from that first block. Recomputed on every
// read from the same blocks that were persisted; never a stored, second TOC copy. The `isNull(source_file)`
// join scopes it to those units, so an imported EPUB chapter — whose hierarchy is its authored nav and
// whose leading `doc_blocks` are `unknown` PM nodes — is untouched. A unit whose first block is not a
// heading (a pre-heading lead section) contributes no entry, and the outline projection maps that
// absence to the root "Start" label.
async function loadDocHeadingByUnit(
  db: DbClient,
  workEntryId: EntryId
): Promise<Map<string, DocumentBlockHeading>> {
  const rows = await db
    .select({ node: docBlocks.nodeJson, readingUnitEntryId: docBlocks.readingUnitEntryId })
    .from(docBlocks)
    .innerJoin(readingUnits, eq(docBlocks.readingUnitEntryId, readingUnits.entryId))
    .where(
      and(
        eq(docBlocks.workEntryId, workEntryId),
        eq(docBlocks.orderIndex, 0),
        isNull(readingUnits.sourceFile)
      )
    );

  const byUnit = new Map<string, DocumentBlockHeading>();
  for (const row of rows) {
    const heading = documentBlockHeading(row.node as DocumentNodeJSON);
    if (heading !== undefined) {
      byUnit.set(row.readingUnitEntryId, heading);
    }
  }
  return byUnit;
}

function toReadingUnitDto(
  unit: ReadingUnitRow,
  unitBlocks: ReadonlyArray<BlockDto>,
  unitDocBlocks: ReadonlyArray<DocBlockDto>,
  headingLevel: number | undefined
): ReadingUnitDto {
  const base = {
    blocks: unitBlocks,
    docBlocks: unitDocBlocks,
    entryId: toEntryId(unit.entryId),
    orderIndex: unit.orderIndex,
    ...(headingLevel === undefined ? {} : { headingLevel })
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

  // Renderable PM `doc_blocks` per unit (#576/#702): a unit whose canonical content lives only in
  // `doc_blocks` (an authored/manual Work, or a canonical PDF import) surfaces when it has non-`unknown`
  // PM content. `ne(type, 'unknown')` drops the `unknown` PM nodes an unknown-only EPUB chapter (#311)
  // persists.
  const docRows = await db
    .select({
      docCount: count(docBlocks.id),
      hasSubstantiveDoc: sql<boolean>`bool_or(btrim(${docBlocks.plaintext}) <> '')`,
      readingUnitEntryId: docBlocks.readingUnitEntryId
    })
    .from(docBlocks)
    .where(and(eq(docBlocks.workEntryId, workEntryId), ne(docBlocks.type, "unknown")))
    .groupBy(docBlocks.readingUnitEntryId);
  // The `doc_blocks` fallback is gated per unit by its own `source_file` (applied in the projection
  // below): a null-`source_file` unit (Markdown/authored/PDF) may use it, while an EPUB spine item
  // (non-null `source_file`) never does, so its no-mdast chapters (unknown-only or unstorable-figure-only)
  // are excluded exactly as before.
  const docByUnit = new Map(docRows.map((row) => [row.readingUnitEntryId, row]));

  // The heading level that starts each Markdown-pipeline unit (#680): the mdast depth of its first
  // block when that block is a heading. Scoped to units with no per-unit source file, so an EPUB —
  // whose hierarchy is its authored nav — is never given a heading-derived outline; its nav (or the
  // flat fallback) still governs. The first block is the one at order index 0.
  const headingRows = await db
    .select({
      mdast: blocks.mdastJson,
      readingUnitEntryId: readingUnits.entryId
    })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .where(
      and(
        eq(readingUnits.workEntryId, workEntryId),
        isNull(readingUnits.sourceFile),
        isNull(blocks.deletedAt),
        eq(blocks.blockType, "heading"),
        eq(blocks.orderIndex, 0)
      )
    );
  const headingLevelByUnit = new Map<string, number>();
  for (const row of headingRows) {
    const depth = mdastHeadingDepth(row.mdast);
    if (depth !== undefined) {
      headingLevelByUnit.set(row.readingUnitEntryId, depth);
    }
  }

  // Reader parity for null-`source_file` Works (#697/#702): a manual Work or a canonical PDF import keeps
  // its content only in `doc_blocks` with a null `reading_units.title`, so its outline heading level and
  // title come from each section's first block — the same source the editor's live Outline derives from —
  // instead of the mdast/nav path above. `loadDocHeadingByUnit` scopes itself to null-`source_file` units,
  // so imported EPUB hierarchy is unchanged.
  const docHeadingByUnit = await loadDocHeadingByUnit(db, workEntryId);
  const resolveHeadingLevel = (entryId: string): number | undefined =>
    headingLevelByUnit.get(entryId) ?? docHeadingByUnit.get(entryId)?.level;
  const resolveTitle = (entryId: string, title: string | null): string | null =>
    title ?? docHeadingByUnit.get(entryId)?.title ?? null;

  // A unit is readable when it has content in the substrate that owns it. Mdast is authoritative for
  // count and substantiveness when present (EPUB/Markdown behavior unchanged). With no mdast, only a
  // null-`source_file` unit surfaces (via `docByUnit`); an EPUB chapter with no mdast — an unknown-only
  // or unstorable-figure-only chapter — has a non-null `source_file` and is excluded.
  const structureUnits = rows.flatMap((row) => {
    if (row.mdastCount > 0) {
      return [
        {
          blockCount: row.mdastCount,
          entryId: row.entryId,
          hasSubstantiveText: row.hasSubstantiveMdast,
          headingLevel: resolveHeadingLevel(row.entryId),
          orderIndex: row.orderIndex,
          sourceFile: row.sourceFile,
          title: resolveTitle(row.entryId, row.title)
        }
      ];
    }
    const doc = row.sourceFile === null ? docByUnit.get(row.entryId) : undefined;
    if (doc === undefined) {
      return [];
    }
    return [
      {
        blockCount: doc.docCount,
        entryId: row.entryId,
        hasSubstantiveText: doc.hasSubstantiveDoc,
        headingLevel: resolveHeadingLevel(row.entryId),
        orderIndex: row.orderIndex,
        sourceFile: row.sourceFile,
        title: resolveTitle(row.entryId, row.title)
      }
    ];
  });
  // An authored EPUB nav (#379) is the first-priority table of contents and is never overridden by
  // derived headings. Only when a work has no authored nav does the heading structure supply one (#680),
  // derived at query time from the units — nothing is persisted, so re-ingestion always yields a fresh
  // outline with no stale rows.
  const authoredToc = await loadTableOfContents(db, workEntryId, structureUnits);
  const tableOfContents = authoredToc.length > 0 ? authoredToc : headingOutlineToc(structureUnits);

  return {
    readingUnits: structureUnits.map(toStructureDto),
    workEntryId,
    // Additive hierarchical TOC: an authored EPUB nav, else a Markdown heading outline; omitted (never
    // an empty array) when neither applies, so the reader falls back to the flat reading-unit list.
    ...(tableOfContents.length === 0 ? {} : { tableOfContents })
  };
}

// A Markdown-pipeline work's heading-derived table of contents (#680): the shared domain projection
// over the units' heading levels, mapped to the served TOC shape. Each entry opens its own unit's top
// (no sub-unit anchor), so `targetUnitEntryId` is the unit's own id. Empty for a single-unit or
// headingless work — the reader then uses the flat reading-unit list.
function headingOutlineToc(
  structureUnits: ReadonlyArray<{
    entryId: string;
    headingLevel: number | undefined;
    title: string | null;
  }>
): ReadonlyArray<TocEntryDto> {
  const outline = buildHeadingOutline(
    structureUnits.map((unit) => ({
      entryId: unit.entryId,
      ...(unit.headingLevel === undefined ? {} : { headingLevel: unit.headingLevel }),
      ...(unit.title === null ? {} : { title: unit.title })
    }))
  );

  return outline.map((entry) => ({
    depth: entry.depth,
    entryId: entry.entryId,
    label: entry.label,
    orderIndex: entry.orderIndex,
    ...(entry.parentEntryId === undefined ? {} : { parentEntryId: entry.parentEntryId }),
    targetUnitEntryId: entry.targetUnitEntryId
  }));
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
    headingLevel: number | undefined;
  }
): ReadingUnitStructureDto {
  const base = {
    blockCount: unit.blockCount,
    entryId: toEntryId(unit.entryId),
    hasSubstantiveText: unit.hasSubstantiveText,
    orderIndex: unit.orderIndex,
    ...(unit.headingLevel === undefined ? {} : { headingLevel: unit.headingLevel })
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

  const headingLevel = firstBlockHeadingLevel(unit.sourceFile, blockRows);
  const base = {
    blocks: blockRows.map(toBlockDto),
    docBlocks: docBlockRows.map(toDocBlockDto),
    entryId: toEntryId(unit.entryId),
    ...(headingLevel === undefined ? {} : { headingLevel }),
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
