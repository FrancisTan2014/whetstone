import { splitSpanIntoBlockRanges } from "@whetstone/domain";
import type { NoteDto } from "@whetstone/contracts";

import type { NoteDraft } from "../notes/noteCapture";
import { noteMarkHueClass } from "./annotationHue.tokens";
import type { NoteMark } from "./noteMarks";
import { blockRangesOverlap, type BlockRange } from "./noteOverlap";
import type { ReaderBlock } from "./readerModel";

// Ordered block ids + a plaintext-length lookup for the active unit — the inputs to laying a note
// span out across blocks (#257). Stable per loaded unit so the per-block memoization holds.
export type UnitBlockIndex = Readonly<{
  lengthById: ReadonlyMap<string, number>;
  orderedIds: ReadonlyArray<string>;
}>;

export function indexBlocks(blocks: ReadonlyArray<ReaderBlock>): UnitBlockIndex {
  return {
    lengthById: new Map(blocks.map((block) => [block.entryId, block.plaintext.length])),
    orderedIds: blocks.map((block) => block.entryId)
  };
}

type AnchorLike = Readonly<{
  blockEntryId: string;
  endBlockEntryId: string;
  endOffset?: number | undefined;
  startOffset?: number | undefined;
}>;

// The per-block character ranges an anchor covers: its split span when it has offsets (single- or
// cross-block), or the whole start block when it is a whole-block note.
function anchorBlockRanges(anchor: AnchorLike, index: UnitBlockIndex): ReadonlyArray<BlockRange> {
  if (anchor.startOffset === undefined || anchor.endOffset === undefined) {
    const length = index.lengthById.get(anchor.blockEntryId);

    return length === undefined
      ? []
      : [{ blockEntryId: anchor.blockEntryId, endOffset: length, startOffset: 0 }];
  }

  return splitSpanIntoBlockRanges(
    {
      blockEntryId: anchor.blockEntryId,
      endBlockEntryId: anchor.endBlockEntryId,
      endOffset: anchor.endOffset,
      startOffset: anchor.startOffset
    },
    index.orderedIds,
    index.lengthById
  );
}

// The underline marks for one block: every note's span range that falls in this block, in the note's
// template hue (#257). A note may contribute a range to several blocks (a cross-block span); a
// whole-block note (no offsets) is excluded — it shows the gutter bar instead.
export function spanMarksForBlock(
  blockEntryId: string,
  notes: ReadonlyArray<NoteDto>,
  index: UnitBlockIndex
): ReadonlyArray<NoteMark> {
  const marks: NoteMark[] = [];

  for (const note of notes) {
    const { anchor } = note;

    if (anchor.startOffset === undefined || anchor.endOffset === undefined) {
      continue;
    }

    for (const range of anchorBlockRanges(anchor, index)) {
      if (range.blockEntryId === blockEntryId) {
        marks.push({
          ariaLabel: `Note on '${anchor.selectedTextSnapshot}'`,
          className: noteMarkHueClass(note.templateId),
          endOffset: range.endOffset,
          noteId: note.entryId,
          startOffset: range.startOffset
        });
      }
    }
  }

  return marks;
}

// Whether a captured draft overlaps any existing note across its whole (possibly cross-block) span,
// so the toolbar can disable "Add note"/"Mark" while keeping the annotations disjoint (#163/#257).
export function draftOverlapsNotes(
  draft: NoteDraft,
  notes: ReadonlyArray<NoteDto>,
  index: UnitBlockIndex
): boolean {
  const draftRanges = anchorBlockRanges(
    {
      blockEntryId: draft.blockEntryId,
      endBlockEntryId: draft.endBlockEntryId ?? draft.blockEntryId,
      endOffset: draft.endOffset,
      startOffset: draft.startOffset
    },
    index
  );

  return notes.some((note) =>
    blockRangesOverlap(draftRanges, anchorBlockRanges(note.anchor, index))
  );
}
