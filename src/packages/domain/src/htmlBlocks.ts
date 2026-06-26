import { toString as mdastToString } from "mdast-util-to-string";
import type { Paragraph, RootContent } from "mdast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import { unified } from "unified";

import {
  blockFromMdastNode,
  type DecomposedBlock,
  type DecomposedFigureImage,
  type DecomposedReadingUnit
} from "./markdownBlocks.js";

// Parse an HTML fragment to hast, then transform to the same mdast intermediate the
// Markdown adapter produces, so every format normalizes onto one block pipeline.
const htmlProcessor = unified().use(rehypeParse, { fragment: true }).use(rehypeRemark);

// The hast tree shape `runSync` accepts; synthetic trees are built structurally and cast
// to it (the processor's own hast types are not re-exported from this package).
type HastTree = Parameters<typeof htmlProcessor.runSync>[0];

// A minimal structural view of a hast node — enough to walk children and read an
// `<img>`'s src/alt — so figure detection avoids depending on hast's full type union.
type HastNode = {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
};

function childrenOf(node: HastNode): HastNode[] {
  return node.children ?? [];
}

// A hast property is only usable when it is a non-empty string (an absent attribute is
// `undefined`; `alt=""` is empty), so both src and alt collapse to `undefined` otherwise.
function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findDescendant(node: HastNode, tagName: string): HastNode | undefined {
  for (const child of childrenOf(node)) {
    if (child.type === "element" && child.tagName === tagName) {
      return child;
    }

    const nested = findDescendant(child, tagName);

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function emptyCaption(): Paragraph {
  return { children: [], type: "paragraph" };
}

// A figure's caption is its `<figcaption>` rendered as mdast (wrapped in a paragraph so
// inline formatting survives) plus the plaintext projection; an image-only figure (no
// figcaption, or an empty one) yields an empty caption.
function captionOf(figure: HastNode): { mdast: RootContent; plaintext: string } {
  const figcaption = findDescendant(figure, "figcaption");

  if (figcaption === undefined) {
    return { mdast: emptyCaption(), plaintext: "" };
  }

  const root = htmlProcessor.runSync({
    children: [{ children: childrenOf(figcaption), properties: {}, tagName: "p", type: "element" }],
    type: "root"
  } as unknown as HastTree);
  const paragraph = root.children[0];

  if (paragraph === undefined) {
    return { mdast: emptyCaption(), plaintext: "" };
  }

  return { mdast: paragraph, plaintext: mdastToString(paragraph) };
}

function figureBlock(img: HastNode, figure: HastNode): DecomposedBlock {
  const src = stringProperty(img.properties?.src);
  const alt = stringProperty(img.properties?.alt);
  const caption = captionOf(figure);
  const image: DecomposedFigureImage | undefined =
    src === undefined ? undefined : alt === undefined ? { src } : { alt, src };

  return Object.freeze({
    blockType: "figure",
    ...(image === undefined ? {} : { image }),
    mdast: caption.mdast,
    plaintext: caption.plaintext
  });
}

// Detect the structural figures the reader anchors to: a `<figure>` containing an
// `<img>` (with an optional `<figcaption>`), or a bare top-level `<img>` (an image-only
// figure). Anything else is left to the mdast pipeline.
function figureFromHast(node: HastNode): DecomposedBlock | undefined {
  if (node.type !== "element") {
    return undefined;
  }

  if (node.tagName === "figure") {
    const img = findDescendant(node, "img");

    return img === undefined ? undefined : figureBlock(img, node);
  }

  if (node.tagName === "img") {
    return figureBlock(node, node);
  }

  return undefined;
}

// Decompose one EPUB chapter's XHTML into a single reading unit of ordered blocks.
// Structural `<figure>`/`<img>` are detected at the hast stage — before `rehype-remark`
// discards images — and emitted as figure blocks in document order; their `<figcaption>`
// is consumed here so it never becomes a heading block or the unit's inferred title. The
// remaining top-level nodes flow through the shared mdast block pipeline. A chapter is
// itself the reading-unit boundary, so headings do not split it; the unit title is the
// chapter's first non-empty heading, if any.
export function decomposeHtmlChapter(html: string): DecomposedReadingUnit {
  const tree = htmlProcessor.parse(html) as unknown as HastNode;
  const blocks: DecomposedBlock[] = [];
  let pending: HastNode[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) {
      return;
    }

    const mdast = htmlProcessor.runSync({ children: pending, type: "root" } as unknown as HastTree);

    for (const node of mdast.children) {
      const block = blockFromMdastNode(node);

      if (block !== undefined) {
        blocks.push(block);
      }
    }

    pending = [];
  };

  for (const node of childrenOf(tree)) {
    const figure = figureFromHast(node);

    if (figure === undefined) {
      pending.push(node);
      continue;
    }

    flushPending();
    blocks.push(figure);
  }

  flushPending();

  const title =
    blocks.find((block) => block.blockType === "heading")?.plaintext.trim() || undefined;

  return Object.freeze({ blocks: Object.freeze([...blocks]), title });
}
