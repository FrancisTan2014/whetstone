// The text selected inside a rendered block, as two raw DOM-text projections: the text that
// precedes the selection within the block, and the selected text itself. The consumer aligns
// these against the block's mdast plaintext (which omits the rendered DOM's structural
// whitespace) by non-whitespace content, so anchors stay correct even when a block repeats text
// and across nested blocks (blockquote, list) where the two projections differ in whitespace.
import { captureCrossBlockSelection, type NoteDraft } from "../notes/noteCapture";
import type { ReaderBlock } from "./readerModel";

export type BlockSelection = Readonly<{
  precedingText: string;
  selectedText: string;
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

  return { precedingText: prefix.toString(), selectedText: range.toString() };
}

// `target.closest(selector)` for an event target that may not be an Element (returns null in
// that case), so callers can match a pointer event against a selector without repeating the
// Element guard each time.
export function eventTargetClosest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

// The rendered block (`[data-block-id]`) a DOM node sits in, or null when the node is outside any
// block. A text node has no `closest`, so resolve through its parent element.
function nodeBlockElement(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;

  return element === null ? null : element.closest("[data-block-id]");
}

// Whether a non-collapsed selection spans more than one rendered block — its start and end lie in
// different `[data-block-id]` elements. A cross-block selection captures a span anchor (#257).
export function isCrossBlockSelection(selection: Selection | null): boolean {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const startBlock = nodeBlockElement(range.startContainer);
  const endBlock = nodeBlockElement(range.endContainer);

  // Selecting to a paragraph's very end leaves the range end at offset 0 of the *next* block, with no
  // text selected there — that is a whole-block selection, not a true cross-block one (#260). Only a
  // non-zero end offset in a different block means the selection genuinely covers two blocks' content.
  return (
    startBlock !== null && endBlock !== null && startBlock !== endBlock && range.endOffset !== 0
  );
}

// A selection that genuinely spans two rendered blocks (#257), read into per-block portions: the
// start block's id, the text before the selection in it, and the selected text from the selection
// start to the start block's end; the end block's id and the selected text from its start to the
// selection end; plus the full selected text. Returns undefined when the selection is not a true
// cross-block one or either endpoint is not inside an addressable block.
export type CrossBlockSelection = Readonly<{
  endBlockEntryId: string;
  endBlockSelectedText: string;
  fullSelectedText: string;
  startBlockEntryId: string;
  startBlockPrecedingText: string;
  startBlockSelectedText: string;
}>;

export function readCrossBlockSelection(
  selection: Selection | null
): CrossBlockSelection | undefined {
  if (selection === null || !isCrossBlockSelection(selection)) {
    return undefined;
  }

  const range = selection.getRangeAt(0);
  const startBlock = nodeBlockElement(range.startContainer);
  const endBlock = nodeBlockElement(range.endContainer);

  /* v8 ignore start -- isCrossBlockSelection already guaranteed both endpoints are addressable
     `[data-block-id]` blocks, so this defensive guard is never taken; it only narrows the types. */
  if (startBlock === null || endBlock === null) {
    return undefined;
  }

  const startBlockEntryId = startBlock.getAttribute("data-block-id");
  const endBlockEntryId = endBlock.getAttribute("data-block-id");

  if (startBlockEntryId === null || endBlockEntryId === null) {
    return undefined;
  }
  /* v8 ignore stop */

  // The text before the selection within the start block.
  const preceding = range.cloneRange();
  preceding.selectNodeContents(startBlock);
  preceding.setEnd(range.startContainer, range.startOffset);

  // The selected portion of the start block: selection start -> end of the start block.
  const startPortion = range.cloneRange();
  startPortion.selectNodeContents(startBlock);
  startPortion.setStart(range.startContainer, range.startOffset);

  // The selected portion of the end block: start of the end block -> selection end.
  const endPortion = range.cloneRange();
  endPortion.selectNodeContents(endBlock);
  endPortion.setEnd(range.endContainer, range.endOffset);

  return {
    endBlockEntryId,
    endBlockSelectedText: endPortion.toString(),
    fullSelectedText: range.toString(),
    startBlockEntryId,
    startBlockPrecedingText: preceding.toString(),
    startBlockSelectedText: startPortion.toString()
  };
}

// Read a genuine cross-block selection into a note draft (#257): resolve each end block's stored
// plaintext from the active unit, then align the selection's per-block portions onto them. Returns
// undefined when the selection is not cross-block, an endpoint block is not in the unit, or a portion
// cannot be aligned onto its block's plaintext.
export function readCrossBlockDraft(
  selection: Selection | null,
  unitBlocks: ReadonlyArray<ReaderBlock>
): NoteDraft | undefined {
  const cross = readCrossBlockSelection(selection);

  if (cross === undefined) {
    return undefined;
  }

  const startText = unitBlocks.find(
    (block) => block.entryId === cross.startBlockEntryId
  )?.plaintext;
  const endText = unitBlocks.find((block) => block.entryId === cross.endBlockEntryId)?.plaintext;

  if (startText === undefined || endText === undefined) {
    return undefined;
  }

  return captureCrossBlockSelection(
    cross.startBlockEntryId,
    startText,
    cross.startBlockPrecedingText,
    cross.startBlockSelectedText,
    cross.endBlockEntryId,
    endText,
    cross.endBlockSelectedText,
    cross.fullSelectedText
  );
}

// The rendered block that should capture a pointer release which landed in the reading column
// but outside a block element (e.g. just past a block edge) — the per-block handlers already
// cover a release on the block itself. Returns undefined when the release is on a block, outside
// the reader, or the selection does not start inside one of the given block elements.
export function releasedBlockElement(
  target: EventTarget | null,
  selection: Selection | null,
  blockElements: ReadonlyArray<HTMLElement>
): HTMLElement | undefined {
  if (eventTargetClosest(target, "[data-block-id]") !== null) {
    return undefined;
  }

  if (eventTargetClosest(target, ".reader") === null) {
    return undefined;
  }

  if (selection === null || selection.rangeCount === 0) {
    return undefined;
  }

  const start = selection.getRangeAt(0).startContainer;

  return blockElements.find((element) => element.contains(start));
}
