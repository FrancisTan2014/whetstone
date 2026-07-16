import { splitSpanIntoBlockRanges } from "@whetstone/domain";
import type { AnchoredNoteDto } from "@whetstone/contracts";

import { noteMarkHueClass } from "./annotationHue.tokens";
import { blockTextContent, rangeWithinElement } from "./blockText";
import { noteMarkLabel } from "./noteActivation";
import { textQuoteRange, wrapRange } from "./textHighlight";

// Render note annotations as render-time DOM decorations over the PM-rendered reader (#313),
// REPLACING the old hast-tree-walk mark application. A note is never a mark in the stored document;
// at load each stored anchor is resolved to a DOM range over the rendered block(s) and wrapped in an
// external highlight span. Cross-block anchors are first-class — they highlight the start block's
// tail, every middle block in full, and the end block's head. Resolution per anchor is: (a) the
// block id + offset against the rendered block(s); (b) on failure (block missing or offsets out of
// range after a doc edit / re-ingest), a dependency-free W3C TextQuote re-anchor (`textHighlight.ts`)
// using the stored snapshots. The pure descriptor step is unit-tested; the DOM application is thin.

// The TextQuote context window: how many characters of the stored block context to keep on each side
// of the exact quote, so the re-anchor can disambiguate a repeated phrase without demanding that the
// entire (possibly long, possibly edited) block text still surround it verbatim.
const CONTEXT_CHARS = 32;

// A resolvable highlight for one sub-block or cross-block note: the offset span (start/end block +
// offsets) for the primary resolution, plus the TextQuote (exact + bounded prefix/suffix) for the
// fallback, and the presentation (hue class via note kind, accessible label, note id).
export type NoteHighlightDescriptor = Readonly<{
  endBlockEntryId: string;
  endOffset: number;
  exact: string;
  kind: "mark" | "note";
  noteId: string;
  prefix: string;
  startBlockEntryId: string;
  startOffset: number;
  suffix: string;
}>;

// The highlight descriptors for a set of notes, in note order. A whole-block note (no offsets) is
// skipped — it draws no inline underline and stays reachable only through the Notes panel (#644). Pure (no DOM), so the anchor-to-decoration
// mapping is tested in isolation; the prefix/suffix are derived from the stored context snapshot so a
// re-anchor stays pinned to the right occurrence even after the block's offsets shift.
export function noteHighlightDescriptors(
  notes: ReadonlyArray<AnchoredNoteDto>
): ReadonlyArray<NoteHighlightDescriptor> {
  const descriptors: NoteHighlightDescriptor[] = [];

  for (const note of notes) {
    const anchor = note.anchor;

    if (anchor.startOffset === undefined || anchor.endOffset === undefined) {
      continue;
    }

    const endBlockEntryId = anchor.endBlockEntryId ?? anchor.blockEntryId;
    const sameBlock = endBlockEntryId === anchor.blockEntryId;

    descriptors.push({
      endBlockEntryId,
      endOffset: anchor.endOffset,
      exact: anchor.selectedTextSnapshot,
      kind: note.kind,
      noteId: note.entryId,
      prefix: anchor.contextSnapshot.slice(
        Math.max(0, anchor.startOffset - CONTEXT_CHARS),
        anchor.startOffset
      ),
      startBlockEntryId: anchor.blockEntryId,
      startOffset: anchor.startOffset,
      // The exact quote of a cross-block note runs past its start block's context snapshot, so only
      // a single-block note can derive a trailing suffix from that snapshot.
      suffix: sameBlock
        ? anchor.contextSnapshot.slice(anchor.endOffset, anchor.endOffset + CONTEXT_CHARS)
        : ""
    });
  }

  return descriptors;
}

function blockIdOf(block: HTMLElement): string {
  /* v8 ignore next 3 -- `block` came from a `[data-block-id]` query, so its dataset value is always a
     string; the guard only narrows the type for the compiler and is never taken at runtime. */
  if (block.dataset.blockId === undefined) {
    return "";
  }

  return block.dataset.blockId;
}

function highlightAttributes(descriptor: NoteHighlightDescriptor): Record<string, string> {
  // The inline underline IS the annotation's direct activation target (#644): a real focusable control
  // (role=button, tab order, an accessible name naming the note kind + anchored text) that opens THAT
  // note when activated by mouse, touch, or keyboard. It still carries the note id so the applied
  // highlight can be located/unwrapped and so overlapping underlines resolve to a chooser.
  return {
    "aria-label": noteMarkLabel(descriptor.kind, descriptor.exact),
    class: `noteMark ${noteMarkHueClass(descriptor.kind)}`,
    "data-note-id": descriptor.noteId,
    role: "button",
    tabindex: "0"
  };
}

// Resolve a descriptor's offset span to one DOM range per intersected block, in reading order, or
// undefined when the span cannot be laid out against the rendered DOM (a block is missing, or an
// offset runs past a block's rendered text after an edit) — the signal to fall back to TextQuote.
function rangesByOffset(
  descriptor: NoteHighlightDescriptor,
  orderedIds: ReadonlyArray<string>,
  lengthById: ReadonlyMap<string, number>,
  blockById: ReadonlyMap<string, HTMLElement>
): ReadonlyArray<Range> | undefined {
  const blockRanges = splitSpanIntoBlockRanges(
    {
      blockEntryId: descriptor.startBlockEntryId,
      endBlockEntryId: descriptor.endBlockEntryId,
      endOffset: descriptor.endOffset,
      startOffset: descriptor.startOffset
    },
    orderedIds,
    lengthById
  );

  if (blockRanges.length === 0) {
    return undefined;
  }

  const ranges: Range[] = [];

  for (const blockRange of blockRanges) {
    const block = blockById.get(blockRange.blockEntryId);

    /* v8 ignore next 3 -- `splitSpanIntoBlockRanges` only emits ids present in `lengthById`, which
       shares its keys with `blockById`, so the block is always found; this only narrows the type. */
    if (block === undefined) {
      return undefined;
    }

    const range = rangeWithinElement(block, blockRange.startOffset, blockRange.endOffset);

    if (range === undefined) {
      return undefined;
    }

    ranges.push(range);
  }

  return ranges;
}

// Re-anchor a descriptor by its stored TextQuote, returning the matching range in the reader, or
// undefined when the quote is not found (so a note whose text no longer exists is simply not
// highlighted rather than mis-placed).
function rangesByQuote(
  descriptor: NoteHighlightDescriptor,
  container: Element
): ReadonlyArray<Range> | undefined {
  const range = textQuoteRange(container, {
    exact: descriptor.exact,
    prefix: descriptor.prefix,
    suffix: descriptor.suffix
  });

  return range === undefined ? undefined : [range];
}

// The ordered note ids covering an activated underline, innermost first: the activated element and any
// enclosing `noteMark` ancestors up to the reader container. Disjoint annotations (#163) wrap disjoint
// text, so this is a single id in the common case; genuinely overlapping notes nest their spans, so the
// chain carries every note the activated text belongs to — the signal to open a chooser, not one note.
function activatedNoteIds(start: Element, container: Element): string[] {
  const ids: string[] = [];
  let mark = start.closest<HTMLElement>(".noteMark");

  while (mark !== null && container.contains(mark)) {
    const id = mark.dataset.noteId;

    if (id !== undefined && !ids.includes(id)) {
      ids.push(id);
    }

    mark = mark.parentElement?.closest<HTMLElement>(".noteMark") ?? null;
  }

  return ids;
}

// Wire direct activation of the inline underlines: a delegated click / Enter / Space on a `noteMark`
// reports the covering note ids so the caller opens that note (or a chooser on genuine overlap), and a
// collapsed tap on an underline is stopped from reaching the reader's document-level selection capture
// (so activating an annotation never starts a new selection flow, #644). A real drag that merely ends on
// an underline still has a live selection, so its release is left to open capture/lookup as usual.
function attachActivation(
  container: Element,
  onActivate: (noteIds: ReadonlyArray<string>) => void
): () => void {
  const fire = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) {
      return false;
    }

    const ids = activatedNoteIds(target, container);

    if (ids.length === 0) {
      return false;
    }

    onActivate(ids);

    return true;
  };

  const onClick = (event: Event): void => {
    if (fire(event.target)) {
      event.stopPropagation();
    }
  };

  const onKeyDown = (event: Event): void => {
    const key = (event as KeyboardEvent).key;

    if (key !== "Enter" && key !== " ") {
      return;
    }

    const target = event.target;

    if (!(target instanceof Element) || target.closest(".noteMark") === null) {
      return;
    }

    // Space would otherwise scroll the reader; Enter/Space here activate the underline instead.
    event.preventDefault();

    if (fire(target)) {
      event.stopPropagation();
    }
  };

  const onRelease = (event: Event): void => {
    const target = event.target;

    if (!(target instanceof Element) || target.closest(".noteMark") === null) {
      return;
    }

    const selection = window.getSelection();

    if (selection !== null && !selection.isCollapsed) {
      return;
    }

    event.stopPropagation();
  };

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("mouseup", onRelease);
  container.addEventListener("touchend", onRelease);

  return () => {
    container.removeEventListener("click", onClick);
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("mouseup", onRelease);
    container.removeEventListener("touchend", onRelease);
  };
}

// Apply every note's highlight over the reader's rendered blocks and return a cleanup that removes
// them. Each note resolves by block id + offset first, then by TextQuote; the resolved range(s) are
// wrapped in an interactive `noteMark` underline carrying the hue, accessible name, and note id (#644 —
// the underline itself is the annotation's direct activation target). Wrapping preserves the rendered
// text, so later notes still resolve against unchanged offsets. `onActivate`, when given, is called
// with the note ids covering an activated underline (innermost first) so the caller opens that note or,
// on genuine overlap, a chooser.
export function applyNoteHighlights(
  container: Element,
  notes: ReadonlyArray<AnchoredNoteDto>,
  onActivate?: (noteIds: ReadonlyArray<string>) => void
): () => void {
  const descriptors = noteHighlightDescriptors(notes);
  const removers: Array<() => void> = [];

  if (descriptors.length === 0) {
    return () => {};
  }

  const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-block-id]"));
  const orderedIds = blocks.map(blockIdOf);
  const lengthById = new Map(
    blocks.map((block) => [blockIdOf(block), blockTextContent(block).length])
  );
  const blockById = new Map(blocks.map((block) => [blockIdOf(block), block]));

  for (const descriptor of descriptors) {
    const ranges =
      rangesByOffset(descriptor, orderedIds, lengthById, blockById) ??
      rangesByQuote(descriptor, container);

    if (ranges === undefined) {
      continue;
    }

    for (const range of ranges) {
      removers.push(wrapRange(range, highlightAttributes(descriptor)));
    }
  }

  const detach = onActivate === undefined ? () => {} : attachActivation(container, onActivate);

  return () => {
    detach();

    for (const remove of removers) {
      remove();
    }
  };
}
