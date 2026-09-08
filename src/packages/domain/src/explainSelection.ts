// Pure selection-context logic for the semantic-map explanation capability (#924). Given a block's
// canonical plaintext and an exact selection range within it, derive a bounded, selection-centered
// window of surrounding text to hand the model — never the whole block, and never merely a fixed
// window from the block's start (which would starve a selection near the end of a long block of any
// preceding context). No React, Fastify, PostgreSQL, or fs — the same "depends on nothing outward"
// invariant every other domain module holds.

// A generous default: enough surrounding prose for the model to read the term's sentence (and often
// the one before/after it) without ever forwarding an entire long block as an untrusted data blob.
export const defaultExplainContextWindowChars = 480;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

// Snap a cropped-context edge inward when the crop boundary lands exactly between the two UTF-16 code
// units of one surrogate pair (an astral character — e.g. an emoji, or a supplementary-plane CJK
// character). Only ever SHRINKS the window (never grows it past the caller's own budget) and only ever
// touches an edge padding actually pushed past the selection's own boundary — the exact selected span
// itself is never modified by this function, matching `buildSelectionContext`'s own invariant.
function snapContextEdgesToCodePoints(
  plaintext: string,
  start: number,
  end: number,
  startOffset: number,
  endOffset: number
): { start: number; end: number } {
  let snappedStart = start;
  if (
    snappedStart > 0 &&
    snappedStart < startOffset &&
    isHighSurrogate(plaintext.charCodeAt(snappedStart - 1)) &&
    isLowSurrogate(plaintext.charCodeAt(snappedStart))
  ) {
    snappedStart += 1;
  }

  let snappedEnd = end;
  if (
    snappedEnd < plaintext.length &&
    snappedEnd > endOffset &&
    isHighSurrogate(plaintext.charCodeAt(snappedEnd - 1)) &&
    isLowSurrogate(plaintext.charCodeAt(snappedEnd))
  ) {
    snappedEnd -= 1;
  }

  return { end: snappedEnd, start: snappedStart };
}

// Bound a block's plaintext to a window of at most `maxContextLength` characters that still contains
// the exact selection. Centers the window on the selection when the block is unbounded on both sides;
// when the selection sits near either edge of the block, the window shifts to use its full budget from
// the side that still has room, rather than wasting space on nothing (this is what keeps a selection
// near the END of a long block supplied with real preceding context, not merely truncated).
//
// A selection itself already at or beyond the budget is returned exactly — verbatim, never truncated
// mid-selection and never padded past it — because the model must see the whole selected span.
export function buildSelectionContext(
  plaintext: string,
  startOffset: number,
  endOffset: number,
  maxContextLength: number = defaultExplainContextWindowChars
): string {
  if (plaintext.length <= maxContextLength) {
    return plaintext;
  }

  const selectionLength = endOffset - startOffset;
  if (selectionLength >= maxContextLength) {
    return plaintext.slice(startOffset, endOffset);
  }

  const padding = Math.floor((maxContextLength - selectionLength) / 2);
  let start = Math.max(0, startOffset - padding);
  let end = Math.min(plaintext.length, endOffset + padding);

  const usedLength = end - start;
  if (usedLength < maxContextLength) {
    if (start === 0) {
      end = Math.min(plaintext.length, start + maxContextLength);
    } else if (end === plaintext.length) {
      start = Math.max(0, end - maxContextLength);
    }
  }

  const snapped = snapContextEdgesToCodePoints(plaintext, start, end, startOffset, endOffset);
  return plaintext.slice(snapped.start, snapped.end);
}

// The exact selected text as the block's canonical plaintext actually holds it, over the same UTF-16
// code-unit offsets every other block-anchored feature (note anchors) uses — a whitespace-only
// difference or a surrogate-pair boundary is preserved exactly, never silently adjusted. Trimming is
// applied only to the returned HEADWORD sent to the model/cache, never to the range used to detect a
// stale selection or to build the context window above.
export function normalizeHeadword(selectedText: string): string {
  return selectedText.trim();
}
