// Where a PDF's reading units BEGIN, and what each one is called (#816).
//
// A ReadingUnit is a unit of READING — a chapter-scale stretch a person sits down with — not a unit of
// markup. The EPUB path never looks at headings: it splits on the publisher's spine, one unit per spine
// document, which is why a real book lands at ~25 chapter-scale units and reads well. A PDF carries the
// same authored navigation as its embedded bookmark outline (#815 already parses it and already matches
// each heading to an entry), so both formats follow ONE product rule and the Reader never branches by
// source format:
//
//     a reading unit is a top-level division of the work's AUTHORED navigation.
//
// Measured on the real Clean Code payload (462 pages): starting a unit at EVERY heading produced 525
// units — roughly one per page, the flat fragment list behind "nearly unusable" — while the file itself
// declares 27 top-level bookmarks (`Chapter 1: Clean Code` … `Epilogue`, `Index`). Docling emitted 39
// level-1 headings for those 27 divisions, because it splits a chapter opener into a LABEL and a TITLE
// (`10` then `Classes`, `Appendix A` then `Concurrency II`) — and both halves resolve to the SAME
// bookmark, the label by substring (`chapter 10: classes` contains `10`). So the boundary test is not
// merely "a level-1 bookmark named this heading" but #815's own principle that a bookmark names ONE
// heading: the FIRST heading that claims a level-1 entry opens that division and the second joins it,
// which yields exactly the publisher's 27 divisions with no numeral-sniffing special case. Each unit is
// titled from the bookmark (`Chapter 10: Classes`) rather than from the block's text (`10`).
//
// This module is pure and dependency-free (no React, Fastify, PostgreSQL, fs, or contracts): it reads one
// already-resolved heading slot per block and answers only "does a unit start here, and what is it
// called". The result is a list of starts in ascending block order beginning at block 0, so a caller that
// slices between consecutive starts places EVERY block in exactly one unit — no block can be lost by
// construction.

import { normalizeOutlineTitle, stripHeadingNumbering } from "./pdfOutlineHeadings.js";

// The outline rung a top-level division sits on. Only the shallowest bookmark level is a DIVISION of the
// work; a deeper bookmark names a section inside a chapter, which stays an ordinary heading block in its
// unit and is navigated within the chapter rather than by opening a new one.
const TOP_OUTLINE_LEVEL = 1;

// Any letter in any script (Latin, Han, Cyrillic …). A heading with none is a number, not a title.
const CONTAINS_LETTER = /\p{L}/u;

// The bookmark that named one heading (#815): `index` identifies WHICH entry (a bookmark names one
// heading, so two headings carrying the same index are the two halves of one opener), and `title` is the
// publisher's own name for the division.
export type PdfReadingUnitOutlineEntry = Readonly<{ index: number; title: string }>;

// One block's heading resolution (#815), reduced to what a unit boundary decision needs: the resolved
// depth, the bookmark that named it (null when the level came from the docling label alone, which is the
// last-resort fallback), and the block's own printed text. `null` in a slot means the block is not a
// heading at all.
export type PdfReadingUnitHeading = Readonly<{
  level: number;
  outlineEntry: PdfReadingUnitOutlineEntry | null;
  text: string;
}>;

// One reading unit's first block and its title. `blockIndex` indexes the same ordered block list the
// caller passed in; `title` is null for a unit no heading named (the leading run before the first
// division, or a division whose heading carries no text).
export type PdfReadingUnitStart = Readonly<{ blockIndex: number; title: string | null }>;

// Decide where each reading unit starts, given one heading slot per block in document order.
//
// A block starts a unit IFF it is the FIRST heading resolved from a given level-1 outline entry — the
// authored top-level division. When the document declares no such division (a PDF with no embedded
// outline, or one whose bookmarks named no heading), the fallback splits at the shallowest heading level
// actually present and joins a heading whose whole text is a division LABEL to the next heading at that
// level, so a book docling split into `10` + `Classes` still yields one unit rather than two.
//
// The returned starts ascend and always begin at block 0: whatever precedes the first division stays one
// neutral, null-titled unit. An empty block list yields no units.
export function decidePdfReadingUnits(
  headings: readonly (PdfReadingUnitHeading | null)[]
): readonly PdfReadingUnitStart[] {
  if (headings.length === 0) {
    return [];
  }
  const starts = outlineDivisions(headings) ?? fallbackDivisions(headings);
  if (starts.length > 0 && starts[0]!.blockIndex === 0) {
    return starts;
  }
  return [{ blockIndex: 0, title: null }, ...starts];
}

// The authored divisions: the first heading each level-1 bookmark named. A second heading resolving to an
// entry already opened is the other half of the same opener (docling's `10` / `Classes` split) or a
// restatement of it — it stays a heading block inside the division it belongs to rather than opening a
// duplicate one. Null (not an empty list) when the document declared no top-level division, so the caller
// can tell "no authored navigation" from "no units".
function outlineDivisions(
  headings: readonly (PdfReadingUnitHeading | null)[]
): PdfReadingUnitStart[] | null {
  const starts: PdfReadingUnitStart[] = [];
  const opened = new Set<number>();
  headings.forEach((heading, blockIndex) => {
    if (heading === null || heading.outlineEntry === null || heading.level !== TOP_OUTLINE_LEVEL) {
      return;
    }
    // Keyed on the ENTRY, never on its title: two bookmarks may share a title (`Introduction`,
    // `Summary`) and must stay two divisions. Over-merging is bounded because every matcher rung is
    // page-anchored (rungs 1–2 same page, rung 3 within one page), so two entries can only collapse
    // when they sit on one page — `Clean Code` (p2) and `Chapter 1: Clean Code` (p32) never do.
    if (opened.has(heading.outlineEntry.index)) {
      return;
    }
    opened.add(heading.outlineEntry.index);
    starts.push({ blockIndex, title: unitTitle(heading) });
  });
  return starts.length > 0 ? starts : null;
}

// The fallback for a document with no authored top-level division: the shallowest heading level present
// is the division level, and a run of adjacent division headings whose text is only a label (`10`,
// `Appendix A`) joins the heading that names it, so the unit is titled `10 Classes` instead of splitting
// into a junk `10` unit followed by `Classes`.
function fallbackDivisions(
  headings: readonly (PdfReadingUnitHeading | null)[]
): PdfReadingUnitStart[] {
  const level = shallowestLevel(headings);
  if (level === null) {
    return [];
  }
  const starts: PdfReadingUnitStart[] = [];
  let index = 0;
  while (index < headings.length) {
    if (!startsDivision(headings[index] ?? null, level)) {
      index += 1;
      continue;
    }
    const blockIndex = index;
    const parts: string[] = [];
    for (;;) {
      const title = unitTitle(headings[index]!);
      if (title !== null) {
        parts.push(title);
      }
      index += 1;
      // Only a bare label needs the NEXT division heading to name it; anything else already titles the
      // unit, and an untitled heading joins nothing.
      if (title === null || !isDivisionLabel(title)) {
        break;
      }
      if (!startsDivision(headings[index] ?? null, level)) {
        break;
      }
    }
    starts.push({ blockIndex, title: parts.length > 0 ? parts.join(" ") : null });
  }
  return starts;
}

function startsDivision(heading: PdfReadingUnitHeading | null, level: number): boolean {
  return heading !== null && heading.level === level;
}

// The shallowest heading level in the document, or null when it has no headings at all (a body of pure
// prose, which stays one unit).
function shallowestLevel(headings: readonly (PdfReadingUnitHeading | null)[]): number | null {
  let shallowest: number | null = null;
  for (const heading of headings) {
    if (heading !== null && (shallowest === null || heading.level < shallowest)) {
      shallowest = heading.level;
    }
  }
  return shallowest;
}

// A unit's title: the bookmark's own title where one named the heading — the publisher's chapter name,
// which is the whole point of using the outline — else the heading's printed text, else nothing.
function unitTitle(heading: PdfReadingUnitHeading): string | null {
  const authored = (heading.outlineEntry?.title ?? "").trim();
  if (authored.length > 0) {
    return authored;
  }
  const printed = heading.text.trim();
  return printed.length > 0 ? printed : null;
}

// Does this heading's whole text merely LABEL a division rather than name it? `Chapter 10`, `Appendix A`,
// and `Part I` reduce to nothing once `stripHeadingNumbering` (#815's matcher, reused rather than
// duplicated) removes the label, and a heading with no letters at all — the bare `10` docling splits off
// from `Classes` — carries no words to title a unit with. Both are labels; neither is a chapter name.
function isDivisionLabel(title: string): boolean {
  const normalized = normalizeOutlineTitle(title);
  return stripHeadingNumbering(normalized).length === 0 || !CONTAINS_LETTER.test(normalized);
}
