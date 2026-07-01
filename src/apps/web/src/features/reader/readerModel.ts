import type {
  BlockDto,
  DocBlockDto,
  ReadingUnitContentDto,
  ReadingUnitStructureDto,
  WorkStructureDto
} from "@whetstone/contracts";

import { stripFlankingFootnoteBrackets } from "./pmFootnotes";

// The reader's view of a work: a lightweight structure (reading units + block counts) loaded
// first, then each active unit's blocks fetched on demand and placed in reading order. A block
// carries the persisted PM document node (`node`, #311 `doc_blocks`) the reader renders through
// `@tiptap/static-renderer` (#312); a Markdown work with no PM blocks falls back to its stored
// `mdast`. Building these pure models keeps ordering out of the React component. Figure blocks
// additionally carry their stored image id + alt so the reader can render `<figure>` from
// `/api/images/:id`; both are absent on non-figure blocks.
export type ReaderBlock = Readonly<{
  alt?: string;
  anchorId?: string;
  backlinkAnchorId?: string;
  blockType: BlockDto["blockType"];
  entryId: string;
  imageResourceId?: string;
  isHeading: boolean;
  mdast?: unknown;
  node?: unknown;
  plaintext: string;
}>;

// A minimal structural view of stored PM JSON — enough to derive the reader fields without pulling
// in the editor schema. The reader trusts the ingest-validated `doc_blocks` shape (#311).
type PmJsonNode = Readonly<{
  attrs?: Record<string, unknown>;
  content?: ReadonlyArray<PmJsonNode>;
  text?: string;
  type: string;
}>;

// A loaded reading unit: its ordered blocks plus the title used for the eyebrow.
export type ReaderUnit = Readonly<{
  blocks: ReadonlyArray<ReaderBlock>;
  entryId: string;
  title?: string;
}>;

// One reading unit in the lightweight structure: ordering metadata and how many blocks it
// holds, but no content — enough to render the 目录 and decide which unit to open.
export type ReaderUnitMeta = Readonly<{
  blockCount: number;
  entryId: string;
  orderIndex: number;
  title?: string;
}>;

// The work's structure: ordered unit metadata, fetched before any unit's blocks.
export type ReaderStructure = Readonly<{
  units: ReadonlyArray<ReaderUnitMeta>;
  workEntryId: string;
}>;

function byOrderIndex(first: { orderIndex: number }, second: { orderIndex: number }): number {
  return first.orderIndex - second.orderIndex;
}

function stringAttr(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = attrs?.[key];
  return typeof value === "string" ? value : undefined;
}

// A node's child nodes, defaulting an absent content array to empty. Centralizing the `?? []` here
// (rather than at each call site) keeps the leaf-node default on one covered branch: a leaf such as a
// text or image node carries no `content`, exercising the empty side through `pmPlaintext`.
function childrenOf(node: PmJsonNode): ReadonlyArray<PmJsonNode> {
  return node.content ?? [];
}

// The block's plaintext is the in-order concatenation of its descendant text nodes — the same
// character stream the static-renderer paints into the DOM — so selection offsets captured against
// the rendered block line up with the note anchor's stored offsets (no structural whitespace, since
// the PM mapping emits none between list items or cells).
function pmPlaintext(node: PmJsonNode): string {
  if (node.text !== undefined) {
    return node.text;
  }

  return childrenOf(node).map(pmPlaintext).join("");
}

// Map a PM node type onto the reader's coarse block kind. Only `figure` (render the stored image)
// and `heading` (eyebrow/structure) are acted on; every other PM block renders uniformly through
// `PmBlock`, so it collapses to `paragraph`.
function pmBlockType(type: string): BlockDto["blockType"] {
  if (type === "heading") {
    return "heading";
  }

  if (type === "figure") {
    return "figure";
  }

  return "paragraph";
}

// Build a reader block from a persisted PM `doc_blocks` node (#311/#312): the addressable id is the
// stored block id, the renderable content is the PM node itself, and a figure additionally surfaces
// its image's stored reference + alt (read from the figure's leading `image` child) so the reader
// serves it from `/api/images/:id`, degrading to caption-only when absent. A `footnoteTarget` block is
// made addressable by its `refId` and given a back-link to the marker's block (#335), reusing the
// reader's block-jump so the two-way footnote navigation mirrors the mdast path.
function toPmReaderBlock(docBlock: DocBlockDto): ReaderBlock {
  // Strip flanking footnote brackets once so the plaintext used for note-anchor offsets matches the
  // stripped text the renderer paints (the reader renders through the same transform).
  const node = stripFlankingFootnoteBrackets(docBlock.node) as PmJsonNode;
  const blockType = pmBlockType(node.type);
  const base = {
    blockType,
    entryId: docBlock.entryId,
    isHeading: node.type === "heading",
    node: docBlock.node,
    plaintext: pmPlaintext(node)
  };

  if (node.type === "footnoteTarget") {
    const refId = stringAttr(node.attrs, "refId");
    return refId === undefined
      ? base
      : { ...base, anchorId: refId, backlinkAnchorId: `${refId}-ref` };
  }

  if (blockType !== "figure") {
    return base;
  }

  const image = childrenOf(node).find((child) => child.type === "image");
  const imageResourceId = stringAttr(image?.attrs, "imageResourceId");
  const alt = stringAttr(image?.attrs, "alt");
  const withImage = imageResourceId === undefined ? base : { ...base, imageResourceId };

  return alt === undefined ? withImage : { ...withImage, alt };
}

function toReaderBlock(block: BlockDto): ReaderBlock {
  const base = {
    blockType: block.blockType,
    entryId: block.entryId,
    isHeading: block.blockType === "heading",
    mdast: block.mdast,
    plaintext: block.plaintext
  };
  const withImage =
    block.imageResourceId === undefined
      ? base
      : { ...base, imageResourceId: block.imageResourceId };
  const withAlt = block.alt === undefined ? withImage : { ...withImage, alt: block.alt };
  const withAnchor =
    block.anchorId === undefined ? withAlt : { ...withAlt, anchorId: block.anchorId };

  return block.backlinkAnchorId === undefined
    ? withAnchor
    : { ...withAnchor, backlinkAnchorId: block.backlinkAnchorId };
}

function toReaderUnitMeta(unit: ReadingUnitStructureDto): ReaderUnitMeta {
  const base = { blockCount: unit.blockCount, entryId: unit.entryId, orderIndex: unit.orderIndex };

  return unit.title === undefined ? base : { ...base, title: unit.title };
}

// The reader structure built from a work's structure DTO: units sorted into reading order so
// the 目录 and navigation read positionally without trusting the array order.
export function buildReaderStructure(structure: WorkStructureDto): ReaderStructure {
  return {
    units: [...structure.readingUnits].sort(byOrderIndex).map(toReaderUnitMeta),
    workEntryId: structure.workEntryId
  };
}

// The ordered blocks of a fetched reading unit, ready to render in reading order. A unit ingested
// with PM `doc_blocks` (EPUB, #311) renders through the static-renderer; a unit with none (Markdown)
// falls back to its mdast blocks so existing reading and note-capture keep working until the PM
// ingestion path covers Markdown too.
export function toReaderBlocks(unit: ReadingUnitContentDto): ReadonlyArray<ReaderBlock> {
  const docBlocks = unit.docBlocks ?? [];

  if (docBlocks.length > 0) {
    return [...docBlocks].sort(byOrderIndex).map(toPmReaderBlock);
  }

  return [...unit.blocks].sort(byOrderIndex).map(toReaderBlock);
}
