import { blockTextContent, rangeWithinElement } from "./blockText";

// Dependency-free TextQuote re-anchoring and range wrapping for note highlights (#313). Replaces the
// `@apache-annotator/dom` matcher + `highlightText`, whose transitive `core-js-pure` polyfill blew
// the web bundle-size budget. The W3C TextQuote match is a small, standard algorithm — locate the
// stored `exact` quote in the rendered text and disambiguate a repeated phrase by its surrounding
// `prefix`/`suffix` — so a focused implementation over the reader's shared `blockText` offset model
// is the right trade-off against a hard performance gate. Both halves are pure-ish and unit-tested:
// `textQuoteRange` computes a character offset, then builds a DOM range via the existing offset walk;
// `wrapRange` wraps a resolved range's text nodes in spans and returns a remover that restores the DOM.

// The stored quote: the exact selected text plus the bounded surrounding context used only to pick
// the right occurrence when the exact text repeats in a block.
type TextQuote = Readonly<{ exact: string; prefix: string; suffix: string }>;

// A contiguous run of one text node to wrap: the node and the half-open `[start, end)` of its text.
type TextSlice = Readonly<{ end: number; node: Text; start: number }>;

// The character offsets in `text` where `exact` occurs, in document order.
function occurrences(text: string, exact: string): number[] {
  const found: number[] = [];

  for (let index = text.indexOf(exact); index !== -1; index = text.indexOf(exact, index + 1)) {
    found.push(index);
  }

  return found;
}

// How well the occurrence at `index` matches its stored context: one point each for a `prefix` the
// preceding text ends with and a `suffix` the following text starts with (an empty side always
// scores, so a quote with no context falls back to the first occurrence).
function contextScore(text: string, index: number, quote: TextQuote): number {
  const before = text.slice(0, index);
  const after = text.slice(index + quote.exact.length);
  const prefixOk = quote.prefix === "" || before.endsWith(quote.prefix);
  const suffixOk = quote.suffix === "" || after.startsWith(quote.suffix);

  return (prefixOk ? 1 : 0) + (suffixOk ? 1 : 0);
}

// The character offset of the best-matching occurrence of `quote.exact` in `text`, preferring the one
// whose context matches and falling back to the first occurrence on a tie, or undefined when the
// exact text is absent.
function quoteOffset(text: string, quote: TextQuote): number | undefined {
  let best: number | undefined;
  let bestScore = -1;

  for (const index of occurrences(text, quote.exact)) {
    const score = contextScore(text, index, quote);

    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }

  return best;
}

// The DOM range over `root`'s rendered text matching the stored TextQuote, or undefined when the
// exact text is no longer present. The exact quote is located in `root.textContent` (the same string
// the reader's offsets index), then mapped to a range by the shared offset walk.
export function textQuoteRange(root: Element, quote: TextQuote): Range | undefined {
  const offset = quoteOffset(blockTextContent(root), quote);

  if (offset === undefined) {
    return undefined;
  }

  return rangeWithinElement(root, offset, offset + quote.exact.length);
}

// The text-node slices a range covers, in document order. A range within one text node is a single
// slice; a range that crosses inline-element boundaries within a block yields the start node's tail,
// each whole middle node, and the end node's head. Empty boundary slices (an offset landing on a node
// edge) are dropped so no empty span is created.
function textSlices(range: Range): TextSlice[] {
  const startNode = range.startContainer as Text;
  const endNode = range.endContainer as Text;

  if (startNode === endNode) {
    return [{ end: range.endOffset, node: startNode, start: range.startOffset }];
  }

  const slices: TextSlice[] = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let within = false;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;

    if (text === startNode) {
      within = true;
      pushSlice(slices, { end: text.length, node: text, start: range.startOffset });
      continue;
    }

    if (text === endNode) {
      pushSlice(slices, { end: range.endOffset, node: text, start: 0 });
      break;
    }

    if (within) {
      pushSlice(slices, { end: text.length, node: text, start: 0 });
    }
  }

  return slices;
}

function pushSlice(slices: TextSlice[], slice: TextSlice): void {
  if (slice.start < slice.end) {
    slices.push(slice);
  }
}

// Replace `node` in the DOM with a `<span>` carrying `attributes` and wrapping that node's text.
function wrapTextNode(node: Text, attributes: Record<string, string>): HTMLElement {
  const span = document.createElement("span");

  for (const [name, value] of Object.entries(attributes)) {
    span.setAttribute(name, value);
  }

  const parent = node.parentNode;

  /* v8 ignore next 3 -- a rendered text node always sits inside the block element, so it has a
     parent; the guard only narrows the type and is never taken at runtime. */
  if (parent === null) {
    return span;
  }

  parent.replaceChild(span, node);
  span.appendChild(node);

  return span;
}

// Narrow `slice.node` to exactly its `[start, end)` text (splitting off any surrounding text) and wrap
// that text in a highlight span.
function wrapSlice(slice: TextSlice, attributes: Record<string, string>): HTMLElement {
  const target = slice.start === 0 ? slice.node : slice.node.splitText(slice.start);
  const length = slice.end - slice.start;

  if (target.length > length) {
    target.splitText(length);
  }

  return wrapTextNode(target, attributes);
}

// Wrap a resolved range's text in `noteMark` highlight span(s) — one per text node, so a range that
// crosses inline-element boundaries within a block is fully highlighted — and return a remover that
// unwraps every span and re-merges the text, restoring the rendered DOM exactly.
export function wrapRange(range: Range, attributes: Record<string, string>): () => void {
  const spans = textSlices(range).map((slice) => wrapSlice(slice, attributes));

  return () => {
    for (const span of spans) {
      const parent = span.parentNode;

      /* v8 ignore next 3 -- the span is in the DOM until cleanup runs, so it always has a parent; the
         guard only narrows the type and is never taken at runtime. */
      if (parent === null) {
        continue;
      }

      while (span.firstChild !== null) {
        parent.insertBefore(span.firstChild, span);
      }

      parent.removeChild(span);
      parent.normalize();
    }
  };
}
