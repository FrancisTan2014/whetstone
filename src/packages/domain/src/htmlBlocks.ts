import { toString as mdastToString } from "mdast-util-to-string";
import type { Paragraph, RootContent } from "mdast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import { unified } from "unified";

import {
  blockFromMdastNode,
  stripPosition,
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
  properties: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
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

// Whether a node has only whitespace text (so an enclosed <img> is its sole content, e.g. DDIA's
// `<p><img/></p>`): such a wrapper is an image-only figure, not a paragraph with an inline image.
function hasOnlyWhitespaceText(node: HastNode): boolean {
  for (const child of childrenOf(node)) {
    if (child.type === "text" && (child.value as string).trim().length > 0) {
      return false;
    }

    if (child.type === "element" && !hasOnlyWhitespaceText(child)) {
      return false;
    }
  }

  return true;
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

  // The caption mdast comes straight from rehype-remark, which annotates every node with
  // source `position`; strip it so figure blocks store the same position-free mdast as the
  // shared block pipeline.
  stripPosition(paragraph);

  return { mdast: paragraph, plaintext: mdastToString(paragraph) };
}

// The reference an image element points at: <img src>, an SVG <image xlink:href|href>, or <object
// data>. hast camelCases xlink:href -> xlinkHref. Matches the src epubSource extracts for the manifest.
function imageSrcOf(node: HastNode): string | undefined {
  const props = node.properties;
  return (
    stringProperty(props.src) ??
    stringProperty(props.xLinkHref) ??
    stringProperty(props.href) ??
    stringProperty(props.data)
  );
}

// The first image-bearing descendant: <img>, an SVG <image>, or an <object> embed (DDIA wraps
// diagrams as <svg><image xlink:href>), so figure detection sees those, not just <img>.
function findImageElement(node: HastNode): HastNode | undefined {
  return (
    findDescendant(node, "img") ?? findDescendant(node, "image") ?? findDescendant(node, "object")
  );
}

function figureBlock(img: HastNode, figure: HastNode): DecomposedBlock {
  const src = imageSrcOf(img);
  const alt = stringProperty(img.properties.alt);
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

// Detect the structural figures the reader anchors to: a `<figure>` containing an image element, a
// bare top-level image, or an image-only wrapper (`<p>`/`<div>`/`<svg>` whose sole content is an image)
// — covering <img>, SVG <image xlink:href>, and <object>. A wrapper with real text is left to mdast.
function figureFromHast(node: HastNode): DecomposedBlock | undefined {
  if (node.type !== "element") {
    return undefined;
  }

  if (node.tagName === "figure") {
    const img = findImageElement(node);

    return img === undefined ? undefined : figureBlock(img, node);
  }

  if (node.tagName === "img" || node.tagName === "image" || node.tagName === "object") {
    return figureBlock(node, node);
  }

  const img = findImageElement(node);

  return img !== undefined && hasOnlyWhitespaceText(node) ? figureBlock(img, node) : undefined;
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

  // Convert one top-level node at a time so its element id (a cross-reference target like Figure 5-2)
  // is stamped onto the resulting block before rehype-remark flattens it away (#252): the first block
  // a node yields carries its anchor id, so a same-work `#id` link resolves to an addressable block.
  for (const node of childrenOf(tree)) {
    const anchorId = node.type === "element" ? stringProperty(node.properties.id) : undefined;
    const figure = figureFromHast(node);

    if (figure !== undefined) {
      blocks.push(anchorId === undefined ? figure : { ...figure, anchorId });
      continue;
    }

    const mdast = htmlProcessor.runSync({ children: [node], type: "root" } as unknown as HastTree);
    let stamped = false;
    for (const child of mdast.children) {
      const block = blockFromMdastNode(child);
      if (block === undefined) {
        continue;
      }
      blocks.push(!stamped && anchorId !== undefined ? { ...block, anchorId } : block);
      stamped = true;
    }
  }

  const title =
    blocks.find((block) => block.blockType === "heading")?.plaintext.trim() || undefined;

  return Object.freeze({ blocks: Object.freeze([...blocks]), title });
}
