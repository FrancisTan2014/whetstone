import type { Nodes as MdastNodes } from "mdast";

// mdast phrasing (inline) content types — the only things a `link` may legally contain.
// Anything else (paragraph, list, listItem, blockquote, code, table, …) is block/flow content.
const phrasingTypes = new Set<string>([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "image",
  "imageReference",
  "link",
  "linkReference",
  "footnote",
  "footnoteReference",
  "html"
]);

type ParentNode = Extract<MdastNodes, { children: unknown[] }>;

function hasChildren(node: MdastNodes): node is ParentNode {
  return Array.isArray((node as { children?: unknown }).children);
}

// A link is safe to render inline only when every descendant is phrasing content.
function isPhrasingOnly(node: MdastNodes): boolean {
  if (!phrasingTypes.has(node.type)) {
    return false;
  }

  return !hasChildren(node) || node.children.every(isPhrasingOnly);
}

// Repair EPUB content where an `<a>` wraps block-level content (legal HTML flow nesting, but
// not representable as an inline mdast `link`): rehype-remark yields a `link` node whose
// children include block nodes (e.g. a `listItem`), and rendering that inline puts a `<li>`
// inside a `<span>`/`<a>` — invalid nesting that triggers React's "`<li>` cannot be a
// descendant of `<li>`" hydration error.
//
// Unwrap any such block-containing link, hoisting its children into the parent so block
// content keeps its valid place in the tree and the inline link wrapper only ever surrounds
// phrasing content. Phrasing-only links are left untouched (still rendered as non-navigating
// link text). Returns a new tree; the input is not mutated.
export function unwrapBlockLinks<T extends MdastNodes>(node: T): T {
  if (!hasChildren(node)) {
    return node;
  }

  const children: MdastNodes[] = [];

  for (const child of node.children) {
    const repaired = unwrapBlockLinks(child);

    if (repaired.type === "link" && !isPhrasingOnly(repaired)) {
      children.push(...repaired.children);
    } else {
      children.push(repaired);
    }
  }

  return { ...node, children } as T;
}
