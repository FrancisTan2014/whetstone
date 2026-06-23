// The text selected inside a rendered block, with the start offset measured against the
// block's text content. Reading the offset from the real Range (rather than searching the
// plaintext for the selected string) keeps anchors correct when a block repeats text.
export type BlockSelection = Readonly<{
  selectedText: string;
  startOffset: number;
}>;

// Read the active selection relative to a rendered block element. Returns undefined when
// there is no usable selection inside this block so the reader does not anchor a note.
export function readBlockSelection(
  blockElement: HTMLElement,
  selection: Selection | null
): BlockSelection | undefined {
  if (selection === null || selection.rangeCount === 0) {
    return undefined;
  }

  const range = selection.getRangeAt(0);

  if (!blockElement.contains(range.startContainer)) {
    return undefined;
  }

  const prefix = range.cloneRange();
  prefix.selectNodeContents(blockElement);
  prefix.setEnd(range.startContainer, range.startOffset);

  return { selectedText: range.toString(), startOffset: prefix.toString().length };
}
