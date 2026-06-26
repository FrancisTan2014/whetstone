// A note's anchored character range within a block. A sub-block note carries both offsets; a
// whole-block note carries neither (it covers the entire block).
type AnchoredRange = Readonly<{ endOffset?: number; startOffset?: number }>;

// Two ranges overlap when they share at least one character. A whole-block range (missing offsets)
// covers the entire block, so it overlaps every other range — including another whole-block range.
// Sub-block ranges use half-open `[startOffset, endOffset)` intersection.
function rangesOverlap(a: AnchoredRange, b: AnchoredRange): boolean {
  if (a.startOffset === undefined || a.endOffset === undefined) {
    return true;
  }

  if (b.startOffset === undefined || b.endOffset === undefined) {
    return true;
  }

  return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}

// Whether a captured selection overlaps any note already anchored in the same block. Annotations
// are disjoint by design (#163), so an overlapping selection must not create a note — the caller
// disables "Add note" while keeping "Look up". Returns false when the block has no notes.
export function selectionOverlapsNote(
  existing: ReadonlyArray<AnchoredRange>,
  selection: AnchoredRange
): boolean {
  return existing.some((note) => rangesOverlap(note, selection));
}
