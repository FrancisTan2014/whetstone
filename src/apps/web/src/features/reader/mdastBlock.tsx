import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Nodes as HastNodes } from "hast";
import type { RootContent } from "mdast";
import { toHast } from "mdast-util-to-hast";
import { memo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { unwrapBlockLinks } from "./phrasingLinks";

// rehype-sanitize's schema is hast-util-sanitize's `defaultSchema`. We additionally drop `img`
// (v0 has no image blocks) so no external image is ever fetched or rendered. Raw HTML never gets
// a hast representation in the first place (toHast runs without `allowDangerousHtml`), so the
// reader never executes raw markup — the same safety the previous react-markdown path enforced.
const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames as string[]).filter((tagName) => tagName !== "img")
};

// In-content links render as non-navigating text: a live `<a href>` would hijack the click,
// navigating the hash-router SPA away and stealing the click from the lookup/annotation
// selection. Keep the link text; drop the navigation. `unwrapBlockLinks` (below) guarantees a
// link only ever wraps phrasing content, so this inline `<span>` never contains block content.
const components = {
  a: ({ children }: { children?: React.ReactNode }): React.JSX.Element => (
    <span className="readerLink">{children}</span>
  )
};

export type BlockContentProps = Readonly<{ node: unknown }>;

// Render a block straight from its stored mdast: mdast → hast (raw HTML dropped) → sanitize →
// React, converted once with no Markdown re-parse. This replaces the mdast → Markdown →
// react-markdown round trip so a unit renders cheaply and scrolling stays smooth. Memoized so a
// block only re-converts when its mdast identity changes.
//
// `unwrapBlockLinks` first repairs EPUB links that wrap block content, so the inline link
// rendering never nests a `<li>` (or other block) inside a `<span>` — which would be invalid
// HTML and trigger a React DOM-nesting/hydration error.
export const BlockContent = memo(function BlockContent({
  node
}: BlockContentProps): React.JSX.Element {
  const safeNode = unwrapBlockLinks(node as RootContent);
  const hast: HastNodes = toHast({ type: "root", children: [safeNode] });

  return toJsxRuntime(sanitize(hast, sanitizeSchema), {
    Fragment,
    components,
    jsx,
    jsxs
  }) as React.JSX.Element;
});
