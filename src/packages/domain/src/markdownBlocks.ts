import { toString as mdastToString } from "mdast-util-to-string";
import type { Heading, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { BlockType } from "./block.js";

// A decomposed block keeps the mdast node (for safe rendering/export) plus a
// plaintext projection (for search) alongside its block type.
export type DecomposedBlock = Readonly<{
  blockType: BlockType;
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

// Map a single top-level mdast node to a decomposed block, keeping the mdast node
// (for safe rendering/export) plus its plaintext projection (for search). Nodes
// outside the supported block types map to `undefined` and are skipped by callers.
export function blockFromMdastNode(node: RootContent): DecomposedBlock | undefined {
  const blockType = blockTypeByNodeType.get(node.type);

  if (blockType === undefined) {
    return undefined;
  }

  return Object.freeze({
    blockType,
    mdast: node,
    plaintext: mdastToString(node)
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
