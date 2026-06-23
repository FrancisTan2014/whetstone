import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import type { Root } from "mdast";
import { unified } from "unified";

import {
  blockFromMdastNode,
  type DecomposedBlock,
  type DecomposedReadingUnit
} from "./markdownBlocks.js";

// Parse an HTML fragment to hast, then transform to the same mdast intermediate the
// Markdown adapter produces, so every format normalizes onto one block pipeline.
const htmlProcessor = unified().use(rehypeParse, { fragment: true }).use(rehypeRemark);

// Decompose one EPUB chapter's XHTML into a single reading unit of ordered blocks.
// Unlike Markdown, a chapter is itself the reading-unit boundary, so headings do not
// split it further; the unit title is the chapter's first non-empty heading, if any.
// Top-level nodes outside the supported block types are skipped in v0.
export function decomposeHtmlChapter(html: string): DecomposedReadingUnit {
  const mdast = htmlProcessor.runSync(htmlProcessor.parse(html)) as Root;
  const blocks: DecomposedBlock[] = [];

  for (const node of mdast.children) {
    const block = blockFromMdastNode(node);

    if (block !== undefined) {
      blocks.push(block);
    }
  }

  const title =
    blocks.find((block) => block.blockType === "heading")?.plaintext.trim() || undefined;

  return Object.freeze({ blocks: Object.freeze([...blocks]), title });
}
