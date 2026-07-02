import type { BlockType, EntryId } from "@whetstone/domain";
import { documentText } from "@whetstone/document";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, docBlocks, entries, entryLinks, readingUnits } from "../../db/schema.js";
import type { IngestedBlock, IngestionEvidence } from "./htmlToDocument.js";
import { insertInBatches } from "./insertBatching.js";

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// A block ready to persist: its rendered mdast + plaintext plus the figure columns
// (`imageResourceId`/`alt`), resolved upstream — `null` on text blocks and on figures
// whose image was not stored.
export type PersistableBlock = Readonly<{
  alt: string | null;
  anchorId: string | null;
  backlinkAnchorId: string | null;
  blockType: BlockType;
  imageResourceId: string | null;
  mdast: unknown;
  plaintext: string;
}>;

export type PersistableReadingUnit = Readonly<{
  blocks: ReadonlyArray<PersistableBlock>;
  // The chapter's decomposed ProseMirror/Tiptap block rows (#311): one entry per top-level PM node,
  // each carrying its stable id, type, and node JSON. Persisted to `doc_blocks` (the reader renders
  // these via `@tiptap/static-renderer`, #312) and registered as addressable Entries so notes and
  // reading positions can anchor to them. Empty on paths with no PM document.
  docBlocks: ReadonlyArray<IngestedBlock>;
  // Fail-loud evidence for this chapter's unrecognized block-level elements (#311). Transient: it
  // rides along so surviving units' evidence reaches the ingestion logger after filtering, and is
  // never written to a column. Defaults to an empty array so callers can flat-map without a guard.
  evidence: ReadonlyArray<IngestionEvidence>;
  // The unit's source-file identity (the EPUB spine item href), or null for a format with no per-unit
  // source file (Markdown/PDF). Persisted to `reading_units.source_file` so an anchor is scoped by
  // (source_file, anchor) for cross-unit reference resolution (#366).
  sourceFile: string | null;
  title: string | undefined;
}>;

export type WriteReadingUnitsInput = Readonly<{
  createEntryId: () => string;
  startOrder: number;
  units: ReadonlyArray<PersistableReadingUnit>;
  workEntryId: EntryId;
}>;

// Persist decomposed reading units and their blocks for a work, in a single batch,
// continuing the work's reading-unit ordering from `startOrder`. Shared by every
// format adapter (Markdown, EPUB) so block/link/entry creation has one owner.
// A unit is kept when it has either legacy mdast blocks OR fidelity PM `docBlocks`:
// dropping a unit with no mdast blocks would silently lose its PM nodes — e.g. an
// unknown-only publisher construct (`<video>`) whose fidelity path emits an `unknown`
// node — which would violate the #311 fail-loud invariant. A unit empty on both sides
// (an EPUB image-only or empty title page) carries no content and is skipped, so no
// empty unit or empty `values()` insert is produced.
export async function writeReadingUnits(
  tx: Transaction,
  input: WriteReadingUnitsInput
): Promise<void> {
  const units = input.units.filter((unit) => unit.blocks.length > 0 || unit.docBlocks.length > 0);

  if (units.length === 0) {
    return;
  }

  const entryRows: { id: string; type: "reading_unit" | "block" }[] = [];
  const readingUnitRows: {
    entryId: string;
    orderIndex: number;
    sourceFile: string | null;
    title: string | null;
    workEntryId: EntryId;
  }[] = [];
  const blockRows: {
    alt: string | null;
    anchorId: string | null;
    backlinkAnchorId: string | null;
    blockType: BlockType;
    entryId: string;
    imageResourceId: string | null;
    mdastJson: unknown;
    orderIndex: number;
    plaintext: string;
    readingUnitEntryId: string;
    workEntryId: EntryId;
  }[] = [];
  // Transitional PM block rows (#311): one row per top-level PM node, keyed by its stable id.
  const docBlockRows: {
    anchorId: string | null;
    id: string;
    nodeJson: unknown;
    orderIndex: number;
    plaintext: string;
    readingUnitEntryId: string;
    type: string;
    workEntryId: EntryId;
  }[] = [];
  const linkRows: { fromEntryId: string; toEntryId: string; type: "contains" }[] = [];

  units.forEach((unit, unitIndex) => {
    const unitEntryId = input.createEntryId();
    entryRows.push({ id: unitEntryId, type: "reading_unit" });
    readingUnitRows.push({
      entryId: unitEntryId,
      orderIndex: input.startOrder + unitIndex,
      sourceFile: unit.sourceFile,
      title: unit.title ?? null,
      workEntryId: input.workEntryId
    });
    linkRows.push({ fromEntryId: input.workEntryId, toEntryId: unitEntryId, type: "contains" });

    // Dual-write the chapter's decomposed PM block rows (#311), preserving the stable PM node id as
    // the row id so #312 can map a block row back to its document node. Each PM block is also a
    // first-class Entry — an `entries` row plus a `contains` link from its unit — so a note anchor or
    // reading position can reference it (their FKs target `entries.id`) exactly like a legacy block,
    // and its plaintext is derived from the node so search/locate resolve it (#312 addressability).
    unit.docBlocks.forEach((docBlock, docBlockIndex) => {
      entryRows.push({ id: docBlock.id, type: "block" });
      linkRows.push({ fromEntryId: unitEntryId, toEntryId: docBlock.id, type: "contains" });
      docBlockRows.push({
        anchorId: docBlock.anchorId,
        id: docBlock.id,
        nodeJson: docBlock.node,
        orderIndex: docBlockIndex,
        plaintext: documentText(docBlock.node),
        readingUnitEntryId: unitEntryId,
        type: docBlock.type,
        workEntryId: input.workEntryId
      });
    });

    unit.blocks.forEach((block, blockIndex) => {
      const blockEntryId = input.createEntryId();
      entryRows.push({ id: blockEntryId, type: "block" });
      blockRows.push({
        alt: block.alt,
        anchorId: block.anchorId,
        backlinkAnchorId: block.backlinkAnchorId,
        blockType: block.blockType,
        entryId: blockEntryId,
        imageResourceId: block.imageResourceId,
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
  await insertInBatches(docBlockRows, (batch) => tx.insert(docBlocks).values(batch));
  await insertInBatches(linkRows, (batch) => tx.insert(entryLinks).values(batch));
}
