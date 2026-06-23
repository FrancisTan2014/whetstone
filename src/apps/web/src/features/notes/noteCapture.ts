import { preselectTemplateId } from "@whetstone/domain";

// A draft captured from a reader selection: which block was selected, the selected text
// and surrounding block context for the anchor, the sub-block offset range (omitted for
// a whole-block selection), and the size-based template preselection.
export type NoteDraft = Readonly<{
  blockEntryId: string;
  contextSnapshot: string;
  endOffset?: number;
  preselectedTemplateId: string;
  selectedText: string;
  startOffset?: number;
}>;

// Build a note draft from a selection inside a single block. The block's plaintext is the
// context; offsets are derived from it. Returns undefined for an empty selection or one
// that is not contained in this block (v0 anchors to a single block).
export function captureBlockSelection(
  blockEntryId: string,
  blockText: string,
  selectedText: string
): NoteDraft | undefined {
  if (selectedText.trim().length === 0) {
    return undefined;
  }

  const startOffset = blockText.indexOf(selectedText);

  if (startOffset < 0) {
    return undefined;
  }

  const base = {
    blockEntryId,
    contextSnapshot: blockText,
    preselectedTemplateId: preselectTemplateId(selectedText),
    selectedText
  };

  if (selectedText === blockText) {
    return base;
  }

  return { ...base, endOffset: startOffset + selectedText.length, startOffset };
}
