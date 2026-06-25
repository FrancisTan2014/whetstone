// The text selected inside a rendered block, as two raw DOM-text projections: the text that
// precedes the selection within the block, and the selected text itself. The consumer aligns
// these against the block's mdast plaintext (which omits the rendered DOM's structural
// whitespace) by non-whitespace content, so anchors stay correct even when a block repeats text
// and across nested blocks (blockquote, list) where the two projections differ in whitespace.
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
