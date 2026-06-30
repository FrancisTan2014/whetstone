import { splitSpanIntoBlockRanges } from "@whetstone/domain";
import type { NoteDto } from "@whetstone/contracts";

import { noteMarkHueClass } from "./annotationHue.tokens";
import { blockTextContent, rangeWithinElement } from "./blockText";
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
// fallback, and the presentation (hue class via template, accessible label, note id).
export type NoteHighlightDescriptor = Readonly<{
  ariaLabel: string;
  endBlockEntryId: string;
  endOffset: number;
  exact: string;
  noteId: string;
  prefix: string;
  startBlockEntryId: string;
  startOffset: number;
  suffix: string;
  templateId: string | null;
}>;

// The highlight descriptors for a set of notes, in note order. A whole-block note (no offsets) is
// skipped — it shows a gutter bar, not an underline. Pure (no DOM), so the anchor-to-decoration
// mapping is tested in isolation; the prefix/suffix are derived from the stored context snapshot so a
// re-anchor stays pinned to the right occurrence even after the block's offsets shift.
export function noteHighlightDescriptors(
  notes: ReadonlyArray<NoteDto>
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
      ariaLabel: `Note on '${anchor.selectedTextSnapshot}'`,
      endBlockEntryId,
      endOffset: anchor.endOffset,
      exact: anchor.selectedTextSnapshot,
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
        : "",
      templateId: note.templateId
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
  return {
    "aria-label": descriptor.ariaLabel,
    class: `noteMark ${noteMarkHueClass(descriptor.templateId)}`,
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

// Apply every note's highlight over the reader's rendered blocks and return a cleanup that removes
// them. Each note resolves by block id + offset first, then by TextQuote; the resolved range(s) are
// wrapped in an external `noteMark` span carrying the hue, the note id, and the accessible label.
// Wrapping preserves the rendered text, so later notes still resolve against unchanged offsets.
export function applyNoteHighlights(container: Element, notes: ReadonlyArray<NoteDto>): () => void {
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

  return () => {
    for (const remove of removers) {
      remove();
    }
  };
}
