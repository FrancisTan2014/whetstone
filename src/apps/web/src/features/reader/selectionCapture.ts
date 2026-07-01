import { preselectTemplateId } from "@whetstone/domain";

import type { NoteDraft } from "../notes/noteCapture";
import { isCjkText, segmentWordAt } from "../lookup/segmentWord";
import { blockTextContent, rangeWithinElement, textOffsetOf } from "./blockText";

// Capture a reader selection as a PM-position note draft (#313). Replaces the old plaintext
// non-whitespace alignment: offsets are read straight from the rendered DOM via the shared
// `blockText` model, so a capture's `{startOffset,endOffset}` index the exact same text the
// annotation re-anchor reads back. Whole-block and cross-block selections are first-class — a
// selection covering an entire block becomes a whole-block note (no offsets, a gutter bar), and a
// selection spanning two blocks records both block ids and both offsets.

// `target.closest(selector)` for an event target that may not be an Element (null otherwise), so
// callers can match a pointer event against a selector without repeating the Element guard.
export function eventTargetClosest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

// The addressable block element (`[data-block-id]`) a DOM node sits in, scoped to `container`, or
// undefined when the node is outside any block in this reader.
function nodeBlockElement(node: Node, container: Element): HTMLElement | undefined {
  const element = node instanceof Element ? node : node.parentElement;

  if (element === null) {
    return undefined;
  }

  const block = element.closest<HTMLElement>("[data-block-id]");

  return block !== null && container.contains(block) ? block : undefined;
}

function blockId(block: HTMLElement): string {
  /* v8 ignore next 3 -- `block` was matched by `[data-block-id]`, so the dataset value is always a
     string; the guard only narrows the type for the compiler and is never taken at runtime. */
  if (block.dataset.blockId === undefined) {
    return "";
  }

  return block.dataset.blockId;
}

// A single-block draft for `[startOffset, endOffset)` of `blockText`. A selection that covers the
// whole block drops its offsets (a whole-block note shows a gutter bar, not an underline). The
// caller has already rejected an empty/whitespace-only range, so the slice carries real text.
function singleBlockDraft(
  id: string,
  blockText: string,
  startOffset: number,
  endOffset: number
): NoteDraft {
  const selectedText = blockText.slice(startOffset, endOffset);

  const base = {
    blockEntryId: id,
    contextSnapshot: blockText,
    preselectedTemplateId: preselectTemplateId(selectedText),
    selectedText
  };

  if (startOffset === 0 && endOffset === blockText.length) {
    return base;
  }

  return { ...base, endOffset, startOffset };
}

// Snap a collapsed CJK tap to the segmented word under the caret (#342): expand the live selection to
// the word's DOM range so lookup queries a real word (六艺, not just 六). A non-collapsed selection —
// an explicit drag — is left untouched so a native drag still selects a custom range. A no-op when the
// segmenter is unavailable, the caret is not inside a block, the tap is not inside a CJK word, or the
// word cannot be laid back out as a range — in every such case the caller keeps the raw selection.
export function snapSelectionToWord(
  selection: Selection | null,
  container: Element,
  locale: string
): void {
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) {
    return;
  }

  const range = selection.getRangeAt(0);
  const block = nodeBlockElement(range.startContainer, container);

  if (block === undefined) {
    return;
  }

  const offset = textOffsetOf(block, range.startContainer, range.startOffset);
  const span = segmentWordAt(blockTextContent(block), offset, locale);

  if (span === undefined || !isCjkText(span.text)) {
    return;
  }

  const wordRange = rangeWithinElement(block, span.start, span.end);

  /* v8 ignore next 3 -- `span` comes from this block's own text, so its offsets are always within the
     block and `rangeWithinElement` resolves; the guard only narrows the type and is never taken. */
  if (wordRange === undefined) {
    return;
  }

  selection.removeAllRanges();
  selection.addRange(wordRange);
}

export function captureSelectionAnchor(
  selection: Selection | null,
  container: Element
): NoteDraft | undefined {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }

  const range = selection.getRangeAt(0);

  if (range.toString().trim().length === 0) {
    return undefined;
  }

  const startBlock = nodeBlockElement(range.startContainer, container);
  const endBlock = nodeBlockElement(range.endContainer, container);

  if (startBlock === undefined || endBlock === undefined) {
    return undefined;
  }

  const startText = blockTextContent(startBlock);
  const startOffset = textOffsetOf(startBlock, range.startContainer, range.startOffset);

  if (endBlock === startBlock) {
    return singleBlockDraft(
      blockId(startBlock),
      startText,
      startOffset,
      textOffsetOf(startBlock, range.endContainer, range.endOffset)
    );
  }

  const endOffset = textOffsetOf(endBlock, range.endContainer, range.endOffset);

  // Selecting to a block's very end can leave the range end at offset 0 of the next block, with no
  // text selected there (#260) — that is a whole-block selection of the start block, not cross-block.
  if (endOffset === 0) {
    return singleBlockDraft(blockId(startBlock), startText, startOffset, startText.length);
  }

  return {
    blockEntryId: blockId(startBlock),
    contextSnapshot: startText,
    endBlockEntryId: blockId(endBlock),
    endOffset,
    preselectedTemplateId: preselectTemplateId(range.toString()),
    selectedText: range.toString(),
    startOffset
  };
}
