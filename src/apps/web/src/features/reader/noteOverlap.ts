// A note's anchored character range within one block: half-open `[startOffset, endOffset)` against
// that block's plaintext. A note that spans blocks (#257) contributes one such range per intersected
// block; a whole-block note covers `[0, length)` of its block.
export type BlockRange = Readonly<{ blockEntryId: string; endOffset: number; startOffset: number }>;

// Whether two ranges in the same block share at least one character (half-open intersection).
function sameBlockOverlap(a: BlockRange, b: BlockRange): boolean {
  return (
    a.blockEntryId === b.blockEntryId && a.startOffset < b.endOffset && b.startOffset < a.endOffset
  );
}

// Whether two sets of per-block ranges overlap — they cover a common character in some shared block.
// Annotations are disjoint by design (#163), evaluated across the whole (possibly cross-block) span
// (#257): the caller disables "Add note"/"Mark" while keeping "Look up" when this is true. Returns
// false when the sets share no block or no character within a shared block.
export function blockRangesOverlap(
  a: ReadonlyArray<BlockRange>,
  b: ReadonlyArray<BlockRange>
): boolean {
  return a.some((rangeA) => b.some((rangeB) => sameBlockOverlap(rangeA, rangeB)));
}
