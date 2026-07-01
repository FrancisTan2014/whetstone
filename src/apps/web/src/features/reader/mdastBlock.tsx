import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Element as HastElement, Nodes as HastNodes, Root } from "hast";
import type { RootContent } from "mdast";
import { toHast } from "mdast-util-to-hast";
import { memo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { unwrapBlockLinks } from "./phrasingLinks";

// Block containers into which `mdast-util-to-hast` inserts `"\n"` separator text nodes between their
// block children (its readability `wrap`). Those newlines are structural, not content: they are absent
// from the block's stored `plaintext` (`mdast-util-to-string`), so leaving them in the rendered DOM
// makes `element.textContent` longer than the plaintext and shifts every capture/re-anchor offset —
// which the server then rejects as `anchor_out_of_range` (#344). Phrasing containers (p, headings,
// inline marks) are excluded, so a meaningful phrasing newline (a soft line break) is preserved.
const BLOCK_WRAP_TAGS = new Set([
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "figure"
]);

// Drop the structural whitespace-only text nodes `mdast-util-to-hast` adds inside block containers, so
// the rendered block's `textContent` equals its stored `plaintext` and offsets align (#344). Only
// block-wrap containers are pruned, where a whitespace-only direct child is always a separator; text
// inside phrasing content (including a soft break's `"\n"`) is never touched.
function stripStructuralWhitespace(node: HastNodes): void {
  if (node.type !== "root" && node.type !== "element") {
    return;
  }

  const parent = node as Root | HastElement;

  if (node.type === "element" && BLOCK_WRAP_TAGS.has(node.tagName)) {
    parent.children = parent.children.filter(
      (child) => !(child.type === "text" && child.value.trim() === "")
    ) as typeof parent.children;
  }

  for (const child of parent.children) {
    stripStructuralWhitespace(child as HastNodes);
  }
}

// rehype-sanitize's schema is hast-util-sanitize's `defaultSchema`. We additionally drop `img`
// (v0 has no image blocks) so no external image is ever fetched or rendered. Raw HTML never gets
// a hast representation in the first place (toHast runs without `allowDangerousHtml`), so the
// reader never executes raw markup — the same safety the previous react-markdown path enforced.
const sanitizeSchema: Schema = {
  ...defaultSchema,
  // Allow the `data-noteref` hint (#250) to survive sanitize on a link so the reader can render a
  // footnote marker as a superscript control; the value is a fixed flag, never user markup.
  attributes: {
    ...defaultSchema.attributes,
    // defaultSchema always defines `a` attributes; the `?? []` is a defensive fallback only.
    /* v8 ignore next */
    a: [...(defaultSchema.attributes?.a ?? []), "dataNoteref"]
  },
  tagNames: (defaultSchema.tagNames as string[]).filter((tagName) => tagName !== "img")
};

// In-content links render as non-navigating text by default — a live `<a href>` would hijack the click,
// navigating the hash-router SPA away and stealing the click from the lookup/annotation selection. But
// a SAME-WORK `#id` link whose target is an addressable block becomes a live internal jump (#252): tap
// scrolls to that block + highlights it, reusing the reader's block-jump. All other links stay text.
// A footnote marker (`data-noteref`, #250) renders that live jump as a quiet superscript control.
function buildComponents(onActivateAnchor: ((anchorId: string) => void) | undefined) {
  return {
    a: ({
      children,
      href,
      ...rest
    }: {
      children?: React.ReactNode;
      href?: string;
    }): React.JSX.Element => {
      const anchorId = href?.startsWith("#") ? href.slice(1) : undefined;
      if (anchorId !== undefined && onActivateAnchor !== undefined) {
        const jump = (
          <button
            className="readerLink readerXref"
            onClick={() => onActivateAnchor(anchorId)}
            type="button"
          >
            {children}
          </button>
        );
        const isNoteref = (rest as Record<string, unknown>)["data-noteref"] !== undefined;
        return isNoteref ? <sup className="readerNoteref">{jump}</sup> : jump;
      }
      return <span className="readerLink">{children}</span>;
    }
  };
}

export type BlockContentProps = Readonly<{
  node: unknown;
  // Resolve+jump a same-work `#id` anchor to its target block; absent leaves all links inert text.
  onActivateAnchor?: (anchorId: string) => void;
}>;

// Render a block straight from its stored mdast: mdast → hast (raw HTML dropped) → sanitize →
// React, converted once with no Markdown re-parse. This replaces the mdast → Markdown →
// react-markdown round trip so a unit renders cheaply and scrolling stays smooth. Memoized so a
// block only re-converts when its mdast identity changes.
//
// `unwrapBlockLinks` first repairs EPUB links that wrap block content, so the inline link
// rendering never nests a `<li>` (or other block) inside a `<span>` — which would be invalid
// HTML and trigger a React DOM-nesting/hydration error.
//
// Note annotations are NOT applied here: they are render-time DOM decorations injected over the
// rendered output from the external anchor store (#313, `applyNoteHighlights`), never marks in the
// stored document.
export const BlockContent = memo(function BlockContent({
  node,
  onActivateAnchor
}: BlockContentProps): React.JSX.Element {
  const safeNode = unwrapBlockLinks(node as RootContent);
  const hast: HastNodes = toHast({ type: "root", children: [safeNode] });
  stripStructuralWhitespace(hast);
  const sanitized = sanitize(hast, sanitizeSchema) as Root;

  return toJsxRuntime(sanitized, {
    Fragment,
    components: buildComponents(onActivateAnchor),
    jsx,
    jsxs
  }) as React.JSX.Element;
});
