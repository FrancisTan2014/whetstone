import { toString as mdastToString } from "mdast-util-to-string";
import type { Heading, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { BlockType } from "./block.js";

// A decomposed block keeps the mdast node (for safe rendering/export) plus a
// plaintext projection (for search) alongside its block type. A figure block also
// carries its transient image reference (the rewritten `<img src>` + optional alt) so
// the server can resolve it to stored bytes on ingest; the caption travels as the
// block's mdast + plaintext, like other blocks.
export type DecomposedFigureImage = Readonly<{ alt?: string; src: string }>;

export type DecomposedBlock = Readonly<{
  blockType: BlockType;
  image?: DecomposedFigureImage;
  mdast: RootContent;
  plaintext: string;
}>;

// Reading units are inferred from headings; the title is the heading text when present.
export type DecomposedReadingUnit = Readonly<{
  blocks: ReadonlyArray<DecomposedBlock>;
  title: string | undefined;
}>;

type ReadingUnitAccumulator = {
  blocks: DecomposedBlock[];
  title: string | undefined;
};

const blockTypeByNodeType = new Map<string, BlockType>([
  ["blockquote", "blockquote"],
  ["code", "code"],
  ["heading", "heading"],
  ["list", "list"],
  ["paragraph", "paragraph"]
]);

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

const imageNodeTypes = new Set(["image", "imageReference"]);

// A structural view of an mdast node — enough to walk children, detect images, and drop
// `position` — so the stripping logic stays simple and avoids the mdast content-model union
// gymnastics.
type MdastNodeLike = {
  children?: MdastNodeLike[];
  position?: unknown;
  type: string;
  value?: string;
};

// v0's content model is text blocks only — images are not a block type. A node counts as an
// image if it is an mdast image/imageReference or a raw HTML `<img>` (manually entered Markdown).
function isImageNode(node: MdastNodeLike): boolean {
  if (imageNodeTypes.has(node.type)) {
    return true;
  }

  return node.type === "html" && typeof node.value === "string" && /<img\b/i.test(node.value);
}

// Recursively drop image descendants from a node's subtree (so an inline image inside a
// paragraph, list item, etc. is removed while its sibling text stays). Mutates the node and
// returns whether any image was removed, so the caller can distinguish "emptied by image
// removal" (skip the block) from an inherently empty node such as a textless heading (keep it).
function stripImages(node: MdastNodeLike): boolean {
  if (node.children === undefined) {
    return false;
  }

  let removed = false;
  node.children = node.children.filter((child) => {
    if (isImageNode(child)) {
      removed = true;
      return false;
    }

    if (stripImages(child)) {
      removed = true;
    }

    return true;
  });

  return removed;
}

// Remark/rehype annotate every node with source `position` (line/column/offset). The reader
// (mdast -> hast -> React) and Markdown export (`blocksToMarkdown`) never read it, so strip it
// recursively before a block is stored — shrinking the persisted/served payload with no change to
// rendered or exported output.
export function stripPosition(node: RootContent): void {
  stripPositionDeep(node as unknown as MdastNodeLike);
}

function stripPositionDeep(node: MdastNodeLike): void {
  delete node.position;

  for (const child of node.children ?? []) {
    stripPositionDeep(child);
  }
}

// Map a single top-level mdast node to a decomposed block, keeping the mdast node
// (for safe rendering/export) plus its plaintext projection (for search). Image
// descendants are stripped first (v0 has no image block); a node left with no
// renderable text once its images are removed — e.g. an image-only paragraph — yields
// `undefined` and is skipped. Nodes outside the supported block types also map to
// `undefined` and are skipped by callers. Source `position` is stripped so stored mdast
// stays small.
export function blockFromMdastNode(node: RootContent): DecomposedBlock | undefined {
  const blockType = blockTypeByNodeType.get(node.type);

  if (blockType === undefined) {
    return undefined;
  }

  const removedImage = stripImages(node as unknown as MdastNodeLike);
  const plaintext = mdastToString(node);

  if (removedImage && plaintext.trim().length === 0) {
    return undefined;
  }

  stripPosition(node);

  return Object.freeze({
    blockType,
    mdast: node,
    plaintext
  });
}

// Decompose Markdown into ordered reading units of ordered blocks. A new reading
// unit starts at each heading; content before the first heading forms a leading
// unit, and a document without headings maps to a single reading unit. Top-level
// nodes outside the supported block types (e.g. thematic breaks, tables, raw HTML)
// are skipped in v0.
export function decomposeMarkdown(markdown: string): ReadonlyArray<DecomposedReadingUnit> {
  const root: Root = markdownProcessor.parse(markdown);
  const units: ReadingUnitAccumulator[] = [];
  let current: ReadingUnitAccumulator | undefined;

  for (const node of root.children) {
    const block = blockFromMdastNode(node);

    if (block === undefined) {
      continue;
    }

    if (node.type === "heading") {
      current = { blocks: [block], title: headingTitle(node) };
      units.push(current);
      continue;
    }

    if (current === undefined) {
      current = { blocks: [block], title: undefined };
      units.push(current);
      continue;
    }

    current.blocks.push(block);
  }

  return units.map(freezeReadingUnit);
}

function headingTitle(node: Heading): string | undefined {
  const text = mdastToString(node).trim();

  return text.length > 0 ? text : undefined;
}

function freezeReadingUnit(unit: ReadingUnitAccumulator): DecomposedReadingUnit {
  return Object.freeze({
    blocks: Object.freeze([...unit.blocks]),
    title: unit.title
  });
}
