// Render-time normalization for footnote/endnote references in a stored PM document (#335). O'Reilly
// EPUB markup wraps a footnote `noteref` in literal `[`/`]` text so the source reads `Data Guard [2]`.
// The reader shows the marker as a clean superscript number, so those flanking brackets must not
// render (a full-size `[` / `]` stranded beside a raised digit reads as broken). This pure transform
// strips only a `[`/`]` pair that DIRECTLY flanks a `footnoteMarker`, leaving ordinary bracketed prose
// (e.g. `[sic]`, code) untouched. It is applied at render and when deriving a block's plaintext, so
// the rendered text and the offset model stay in step. No node is mutated; a new tree is returned.

// A minimal structural view of stored PM JSON — enough to walk inline content without importing the
// editor schema. The reader trusts the ingest-validated shape (#311).
type PmJsonNode = Readonly<{
  attrs?: Record<string, unknown>;
  content?: ReadonlyArray<PmJsonNode>;
  text?: string;
  type: string;
}>;

function isTextNode(node: PmJsonNode): node is PmJsonNode & { text: string } {
  return node.type === "text" && typeof node.text === "string";
}

// Rewrite one inline-content array: for every `footnoteMarker`, if its immediately preceding text ends
// with `[` and its immediately following text starts with `]`, drop that single pair. The check
// requires BOTH sides so a lone bracket or unrelated `[sic]` is never touched.
function stripBracketsAround(children: ReadonlyArray<PmJsonNode>): ReadonlyArray<PmJsonNode> {
  const next = [...children];

  for (const [index, current] of next.entries()) {
    if (current.type !== "footnoteMarker") {
      continue;
    }

    const before = next[index - 1];
    const after = next[index + 1];
    if (
      before !== undefined &&
      isTextNode(before) &&
      before.text.endsWith("[") &&
      after !== undefined &&
      isTextNode(after) &&
      after.text.startsWith("]")
    ) {
      next[index - 1] = { ...before, text: before.text.slice(0, -1) };
      next[index + 1] = { ...after, text: after.text.slice(1) };
    }
  }

  return next;
}

// Return a copy of `node` with every footnote marker's flanking `[`/`]` pair removed, recursing into
// nested content (list items, blockquotes, table cells, figure captions). A leaf node with no content
// is returned unchanged.
export function stripFlankingFootnoteBrackets<Node>(node: Node): Node {
  const pmNode = node as unknown as PmJsonNode;
  if (pmNode.content === undefined) {
    return node;
  }

  const recursed = pmNode.content.map((child) => stripFlankingFootnoteBrackets(child));
  return { ...pmNode, content: stripBracketsAround(recursed) } as unknown as Node;
}
