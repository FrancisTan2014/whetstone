import { toEntryId } from "@whetstone/domain";
import type { NoteAnchorDto } from "@whetstone/contracts";

// A draft captured from a reader selection: which block was selected (and, for a cross-block span,
// the end block), the selected text and surrounding block context for the anchor, the offset range
// (startOffset within the start block, endOffset within the end block; omitted for a whole single
// block), and the size-based template preselection. The reader captures drafts straight from the
// rendered DOM (`features/reader/selectionCapture`), so its offsets index the same text the
// annotation re-anchor reads back.
export type NoteDraft = Readonly<{
  blockEntryId: string;
  contextSnapshot: string;
  endBlockEntryId?: string;
  endOffset?: number;
  preselectedTemplateId: string;
  selectedText: string;
  startOffset?: number;
}>;

// The note anchor payload for a captured draft: the start block (and end block for a cross-block
// span, defaulting to the start block), the context + selected-text snapshots, and the offset range
// (omitted for a whole single block). Shared by the note editor's create request and the one-tap
// mark (#255) so a note and a mark anchor identically.
export function draftToAnchor(draft: NoteDraft): NoteAnchorDto {
  const base = {
    blockEntryId: toEntryId(draft.blockEntryId),
    contextSnapshot: draft.contextSnapshot,
    endBlockEntryId: toEntryId(draft.endBlockEntryId ?? draft.blockEntryId),
    selectedTextSnapshot: draft.selectedText
  };

  if (draft.startOffset === undefined || draft.endOffset === undefined) {
    return base;
  }

  return { ...base, endOffset: draft.endOffset, startOffset: draft.startOffset };
}
