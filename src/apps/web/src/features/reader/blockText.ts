// The one offset/text model shared by selection capture and annotation re-anchoring (#313). A
// block's character offsets are positions in its *rendered* DOM text — the in-order concatenation
// of its descendant text nodes, i.e. `element.textContent`. For a stored PM block this equals the
// block's plaintext (the renderer emits no structural whitespace), so capture, re-anchor, and the
// server's anchor validation all read offsets in one consistent space. Keeping both directions
// (point -> offset for capture, offset -> point/range for re-anchor) here guarantees they agree.

// A point in a block's rendered text: the text node it lands in and the character offset within it.
type TextPoint = Readonly<{ node: Text; offset: number }>;

// The block's rendered text — the same string the offsets index into. An element's `textContent` is
// always a string (never null, which only Document/DocumentType nodes return), so the cast is safe.
export function blockTextContent(element: Element): string {
  return element.textContent as string;
}

// The character offset of a DOM point `(node, nodeOffset)` within `root`'s rendered text. Built from
// a range spanning `root`'s start to the point, so it works whether the point's container is a text
// node or an element (a child-index boundary). Used by capture to turn a selection's endpoints into
// block offsets.
export function textOffsetOf(root: Node, node: Node, nodeOffset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, nodeOffset);

  return range.toString().length;
}

// The text node + local offset at character offset `offset` within `root`'s rendered text, or
// undefined when `offset` runs past the end of that text. Walks text nodes in document order,
// charging each its length; an offset that lands exactly on a node boundary resolves to the end of
// the node it completes, so the full `[0, totalLength]` range (including the block's very end) is
// addressable.
function pointAtOffset(root: Node, offset: number): TextPoint | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = (node as Text).length;

    if (remaining <= length) {
      return { node: node as Text, offset: remaining };
    }

    remaining -= length;
  }

  return undefined;
}

// A DOM range covering the half-open character range `[start, end)` of `element`'s rendered text, or
// undefined when the bounds are inverted or run past the text (so a stale anchor falls through to the
// TextQuote re-anchor instead of highlighting the wrong span). Used by annotation re-anchoring.
export function rangeWithinElement(
  element: Element,
  start: number,
  end: number
): Range | undefined {
  if (start < 0 || end < start) {
    return undefined;
  }

  const startPoint = pointAtOffset(element, start);
  const endPoint = pointAtOffset(element, end);

  if (startPoint === undefined || endPoint === undefined) {
    return undefined;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);

  return range;
}
