import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

// Blocks are stored as mdast nodes, but the reader renders through react-markdown,
// which consumes Markdown text. Serialize a single block's node back to Markdown so
// it can be rendered safely; remark-gfm mirrors the ingestion parser so GFM-only
// nodes (e.g. strikethrough) round-trip. This is per-block rendering support, not
// whole-work Markdown export.
const blockProcessor = unified().use(remarkGfm).use(remarkStringify);

export function blockToMarkdown(node: unknown): string {
  const root: Root = { children: [node as RootContent], type: "root" };

  return blockProcessor.stringify(root).trimEnd();
}

// Reconstruct a whole work's Markdown from its blocks' mdast nodes in reading order.
// This is the export counterpart to ingestion's decomposition: serializing every
// block node back into one document round-trips the work's structure.
export function blocksToMarkdown(nodes: ReadonlyArray<unknown>): string {
  const root: Root = { children: nodes.map((node) => node as RootContent), type: "root" };

  return blockProcessor.stringify(root).trimEnd();
}
