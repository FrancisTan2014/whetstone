import { preselectTemplateId, toEntryId } from "@whetstone/domain";
import type { NoteAnchorDto } from "@whetstone/contracts";

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
// context and the anchor offsets are the selection's position within it. The selection is
// read from the rendered DOM, whose text projection inserts structural whitespace (leading /
// trailing newlines, inter-list-item breaks) that the mdast plaintext omits; we therefore
// align the two by their **non-whitespace** content rather than by raw character offset. This
// keeps blockquote and list selections working, anchors repeated text to the occurrence the
// user selected (not the first match), and stores the plaintext slice so the anchor is
// internally consistent. Returns undefined for an empty/whitespace-only selection or one whose
// non-whitespace content does not line up with the block's plaintext (v0 anchors to one block).
export function captureBlockSelection(
  blockEntryId: string,
  blockText: string,
  precedingText: string,
  selectedText: string
): NoteDraft | undefined {
  const mapped = mapSelectionOntoBlock(blockText, precedingText, selectedText);

  if (mapped === undefined) {
    return undefined;
  }

  const base = {
    blockEntryId,
    contextSnapshot: blockText,
    preselectedTemplateId: preselectTemplateId(mapped.selectedText),
    selectedText: mapped.selectedText
  };

  if (mapped.selectedText === blockText) {
    return base;
  }

  return { ...base, endOffset: mapped.endOffset, startOffset: mapped.startOffset };
}

// The note anchor payload for a captured draft: the block id, the context + selected-text snapshots,
// and the sub-block offsets (omitted for a whole-block selection). Shared by the note editor's create
// request and the one-tap mark (#255) so a note and a mark anchor identically.
export function draftToAnchor(draft: NoteDraft): NoteAnchorDto {
  const base = {
    blockEntryId: toEntryId(draft.blockEntryId),
    contextSnapshot: draft.contextSnapshot,
    selectedTextSnapshot: draft.selectedText
  };

  if (draft.startOffset === undefined || draft.endOffset === undefined) {
    return base;
  }

  return { ...base, endOffset: draft.endOffset, startOffset: draft.startOffset };
}

// The plaintext-relative anchor for a DOM selection, found by non-whitespace alignment.
type MappedSelection = Readonly<{ endOffset: number; selectedText: string; startOffset: number }>;

function nonWhitespace(text: string): string {
  return (text.match(/\S/g) ?? []).join("");
}

// Map a DOM selection (its preceding text and selected text) onto the block's plaintext. We
// skip `before` non-whitespace characters to find the start, then consume as many
// non-whitespace characters as the selection holds to find the end — ignoring the whitespace
// that differs between the rendered DOM and the plaintext. Returns undefined when the selection
// is empty, runs past the text, or its non-whitespace content does not match at that position.
function mapSelectionOntoBlock(
  blockText: string,
  precedingText: string,
  selectedText: string
): MappedSelection | undefined {
  const selectedCore = nonWhitespace(selectedText);

  if (selectedCore.length === 0) {
    return undefined;
  }

  const before = nonWhitespace(precedingText).length;
  const startOffset = offsetAfterNonWhitespace(blockText, before);

  if (startOffset === undefined) {
    return undefined;
  }

  const endOffset = consumeNonWhitespace(blockText, startOffset, selectedCore.length);

  if (endOffset === undefined) {
    return undefined;
  }

  const slice = blockText.slice(startOffset, endOffset);

  if (nonWhitespace(slice) !== selectedCore) {
    return undefined;
  }

  return { endOffset, selectedText: slice, startOffset };
}

// The index of the block character at which exactly `count` non-whitespace characters have
// already been seen — i.e. the start of the next non-whitespace run. Undefined when the block
// has fewer than `count + 1` non-whitespace characters.
function offsetAfterNonWhitespace(blockText: string, count: number): number | undefined {
  let seen = 0;

  for (let index = 0; index < blockText.length; index += 1) {
    if (/\S/.test(blockText[index] as string)) {
      if (seen === count) {
        return index;
      }

      seen += 1;
    }
  }

  return undefined;
}

// Walk forward from `start`, consuming `count` non-whitespace characters, and return the index
// just past the last one. Undefined when the block runs out of non-whitespace first.
function consumeNonWhitespace(blockText: string, start: number, count: number): number | undefined {
  let consumed = 0;
  let endOffset = start;

  for (let index = start; index < blockText.length && consumed < count; index += 1) {
    if (/\S/.test(blockText[index] as string)) {
      consumed += 1;
    }

    endOffset = index + 1;
  }

  return consumed < count ? undefined : endOffset;
}
