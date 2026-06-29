// One intersected block's slice of a (possibly cross-block) note span: a half-open
// `[startOffset, endOffset)` range against that block's plaintext (#257).
export type BlockSpanRange = Readonly<{
  blockEntryId: string;
  endOffset: number;
  startOffset: number;
}>;

// A note's offset span: the start block + offset and the end block + offset. For a single-block
// note the two block ids are equal.
export type NoteSpan = Readonly<{
  blockEntryId: string;
  endBlockEntryId: string;
  endOffset: number;
  startOffset: number;
}>;

// Split a note span into one offset range per intersected block, in reading order: the start block
// runs from `startOffset` to its end, each full middle block from 0 to its end, and the end block
// from 0 to `endOffset`; a single-block span is just `[startOffset, endOffset)` in that block. Blocks
// are given as their ids in reading order plus a length lookup. Returns no ranges when either
// endpoint is unknown or the end block precedes the start block (a span that cannot be laid out), and
// skips any block that collapses to an empty range, so callers render only the covered characters.
export function splitSpanIntoBlockRanges(
  span: NoteSpan,
  orderedBlockIds: ReadonlyArray<string>,
  blockLengthById: ReadonlyMap<string, number>
): ReadonlyArray<BlockSpanRange> {
  const startIndex = orderedBlockIds.indexOf(span.blockEntryId);
  const endIndex = orderedBlockIds.indexOf(span.endBlockEntryId);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return [];
  }

  const ranges: BlockSpanRange[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    const blockEntryId = orderedBlockIds[index] as string;
    const length = blockLengthById.get(blockEntryId);

    if (length === undefined) {
      continue;
    }

    const startOffset = index === startIndex ? span.startOffset : 0;
    const endOffset = index === endIndex ? span.endOffset : length;

    if (endOffset > startOffset) {
      ranges.push({ blockEntryId, endOffset, startOffset });
    }
  }

  return ranges;
}
