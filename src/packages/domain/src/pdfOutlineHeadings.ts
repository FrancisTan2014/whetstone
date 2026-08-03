// The pure "how deep is this heading" rule (#815). A PDF's docling label says only THAT a line is a
// heading, never how deep it sits: measured across four ranges of two real books, docling emitted
// `title` zero times and `section_header` 12/19/23/20 times, so a label-derived level makes every
// heading in a real book an H2 and the Reader's outline a flat wall of siblings.
//
// The depth a document actually carries is its own embedded bookmark outline — the author's DECLARED
// hierarchy, imported once by the worker and travelling in the structured contract beside page/bbox/
// confidence as ordinary extraction provenance. This module RESOLVES a heading's level from that
// evidence and nothing else: it is pure and dependency-free (no React, Fastify, PostgreSQL, fs, or
// contracts), never re-opens the PDF, and never guesses from geometry or font size. When the outline
// cannot justify a level, it says so (`null`) and the caller falls back to the label — a level is never
// silently claimed.
//
// The matcher is deliberately CONSERVATIVE and page-anchored, because a wrong level misnests a whole
// chapter in the Reader's outline while a missed match merely leaves today's flat level in place. It
// climbs three rungs, stopping at the first that matches; ties within a rung resolve to the SHALLOWEST
// level, so an ambiguous heading is never pushed deeper than the evidence supports.

// One entry of the PDF's embedded outline, reduced to what a level decision needs. Structural (not the
// contracts type) so this module stays dependency-free and testable without a whole StructuredDocument.
// `level` and `pageNumber` are 1-based, as the worker projects them.
export type PdfOutlineEntry = Readonly<{
  title: string;
  level: number;
  pageNumber: number;
}>;

// The heading text and the page it was extracted from — the only two facts a match is allowed to use.
export type PdfHeadingCandidate = Readonly<{
  text: string;
  pageNumber: number;
}>;

// The canonical document schema's deepest heading. A PDF outline can nest deeper than the content model
// can express (the corpus probe found trees up to depth 6, and a hostile file could go further), so a
// deeper matched level CLAMPS here rather than producing a node the schema would reject.
export const MAX_PDF_HEADING_LEVEL = 6;

// Punctuation stripped from BOTH ends while normalizing, so `— Objects —`, `| Chapter 5 |`, and
// `Chapter 5:` compare equal to their bare text. Interior punctuation is preserved: only the decorative
// frame a printer or a bookmark author wrapped the title in is removed.
const STRIPPED_EDGE_PUNCTUATION = new Set([
  ".",
  ",",
  ":",
  ";",
  "-",
  "\u2013",
  "\u2014",
  "\u2022",
  "\u00b7",
  "|",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}"
]);

// A leading `Chapter 6:` / `Appendix A.` / `Part I —` / `Section 3` label, stripped from BOTH sides
// before the last rung's comparison. This is the single most common shape of disagreement between a
// bookmark and the printed heading: measured on Clean Code, the bookmark `"Chapter 6: Objects and Data
// Structures"` names the page whose printed heading is just `"Objects and Data Structures"`. The
// numbering must be followed by end-of-string or a separator, so a title that merely STARTS with the
// word "Section" (e.g. `"Sections of a report"`) is left untouched.
const NUMBERED_HEADING_PREFIX =
  /^(?:chapter|appendix|part|section)\s+(?:\d{1,4}|[ivxlcdm]{1,7}|[a-z])(?=$|[\s.:\u2013\u2014-])[\s.:\u2013\u2014-]*/u;

// How far a heading may sit from its bookmark's page on the last rung. A bookmark commonly points at the
// page the chapter STARTS on while docling attributes the heading text to the facing or following page,
// so one page of slack is the difference between matching a real chapter opener and matching nothing; a
// wider window would start borrowing another section's level.
const PAGE_PROXIMITY = 1;

// Normalize a title for comparison: NFKC (so a full-width or ligature form compares equal), NBSP to a
// plain space, collapse runs of whitespace, trim, lowercase, then strip the decorative punctuation a
// printer frames a heading with. Stated here rather than shared with the page-furniture rules (#811)
// because the two answer different questions and change for different reasons — "is this the same
// running head?" versus "does this bookmark name this heading?" — and a heading match must not silently
// shift when a furniture threshold is tuned.
export function normalizeOutlineTitle(text: string): string {
  const collapsed = text
    .normalize("NFKC")
    .replaceAll("\u00a0", " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return trimEdgePunctuation(collapsed);
}

function trimEdgePunctuation(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isTrimmable(text[start]!)) {
    start += 1;
  }
  while (end > start && isTrimmable(text[end - 1]!)) {
    end -= 1;
  }
  return text.slice(start, end).trim();
}

function isTrimmable(character: string): boolean {
  return STRIPPED_EDGE_PUNCTUATION.has(character) || character === " ";
}

// Strip a leading `Chapter 6:` / `Appendix A` / `Part I —` label from an ALREADY normalized title, and
// re-trim the punctuation the strip may have exposed. Exported so the rule that decides "these name the
// same heading" is directly testable rather than only observable through a resolved level.
export function stripHeadingNumbering(normalizedTitle: string): string {
  return trimEdgePunctuation(normalizedTitle.replace(NUMBERED_HEADING_PREFIX, ""));
}

// One rung of the ladder: given the candidate's normalized forms, does this outline entry name it?
type OutlineRung = (candidate: NormalizedCandidate, entry: PdfOutlineEntry) => boolean;

type NormalizedCandidate = Readonly<{
  normalized: string;
  stripped: string;
  pageNumber: number;
}>;

// The ladder, most to least specific. Each rung is page-anchored, so a heading can only ever inherit the
// level of a bookmark that points at (or immediately beside) the page it was extracted from — an
// identical title elsewhere in the book cannot capture it.
const OUTLINE_RUNGS: readonly OutlineRung[] = [
  // 1. The bookmark and the printed heading are the same text on the same page.
  (candidate, entry) =>
    entry.pageNumber === candidate.pageNumber &&
    normalizeOutlineTitle(entry.title) === candidate.normalized,
  // 2. The bookmark on that page CONTAINS the heading text: bookmarks routinely carry a prefix or a
  //    trailing qualifier the printed heading omits.
  (candidate, entry) =>
    entry.pageNumber === candidate.pageNumber &&
    normalizeOutlineTitle(entry.title).includes(candidate.normalized),
  // 3. With a `Chapter 6:`-style label stripped from either side, the two are equal within one page.
  (candidate, entry) =>
    Math.abs(entry.pageNumber - candidate.pageNumber) <= PAGE_PROXIMITY &&
    candidate.stripped.length > 0 &&
    stripHeadingNumbering(normalizeOutlineTitle(entry.title)) === candidate.stripped
];

// Resolve the heading level a document's own outline justifies for one heading candidate, or null when
// no bookmark names it (the caller then falls back to the label-derived level). The first rung that
// matches wins; among that rung's matches the SHALLOWEST level wins, so an ambiguous heading is never
// pushed deeper than the evidence supports. A level deeper than the canonical model clamps to
// `MAX_PDF_HEADING_LEVEL`. A blank heading carries no evidence and matches nothing.
export function resolveOutlineHeadingLevel(
  candidate: PdfHeadingCandidate,
  outline: readonly PdfOutlineEntry[]
): number | null {
  const normalized = normalizeOutlineTitle(candidate.text);
  if (normalized.length === 0) {
    return null;
  }
  const normalizedCandidate: NormalizedCandidate = {
    normalized,
    pageNumber: candidate.pageNumber,
    stripped: stripHeadingNumbering(normalized)
  };
  for (const rung of OUTLINE_RUNGS) {
    const level = shallowestMatch(normalizedCandidate, outline, rung);
    if (level !== null) {
      return Math.min(level, MAX_PDF_HEADING_LEVEL);
    }
  }
  return null;
}

function shallowestMatch(
  candidate: NormalizedCandidate,
  outline: readonly PdfOutlineEntry[],
  rung: OutlineRung
): number | null {
  let shallowest: number | null = null;
  for (const entry of outline) {
    if (rung(candidate, entry) && (shallowest === null || entry.level < shallowest)) {
      shallowest = entry.level;
    }
  }
  return shallowest;
}
