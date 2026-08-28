// The pure "what is page furniture" rule (#811). Running heads, running feet, and folios are artifacts
// of how a source was PRINTED, not something a publisher wrote into the work, so they are extraction
// evidence and must never become addressable blocks that notes, search, reading position, and correction
// then depend on. Docling emits these items INSIDE the body (its separate `furniture` group is deprecated
// and arrives empty in 2.114), so ingestion is the only place that can tell body content from layout
// debris — the Reader never filters what ingestion admitted.
//
// The rules are deliberately CONSERVATIVE, because a false exclusion silently destroys content while a
// false keep only leaves a stray line an administrator can delete: an item is excluded only when it is
// empty, is shaped like a folio, repeats across pages, or restates a heading the document already
// carries. Docling mislabels some chapter openers `page_header`; such a unique, heading-less candidate is
// KEPT as readable text.
//
// Repetition and heading restatement are additionally tested against a FOLIO-STRIPPED form of the text
// (#826), because a large class of trade books sets the running head as `<chapter title> · <folio>`. That
// embedded page number makes every instance a DIFFERENT string, so repetition never reaches its
// threshold however many pages are imported, and the folio suffix breaks equality with the real heading —
// the running head survives into the prose. Stripping one edge folio restores both comparisons.
//
// Pure and dependency-free (no React, Fastify, PostgreSQL, fs, or contracts): the caller passes the
// document's ordered top-level body items reduced to label/page/text, so every rule is unit-testable in
// isolation and a planted bug in a threshold or a regex fails a test rather than a book.

// The docling labels that make a top-level body item a furniture CANDIDATE. Only these are ever
// considered for exclusion; every other label maps normally, so the mapper's `unknown` fallback for a
// genuinely unrecognized construct is untouched.
const FURNITURE_CANDIDATE_LABELS: ReadonlySet<string> = new Set(["page_header", "page_footer"]);

// The labels whose text counts as a heading the document already carries. A running head usually
// restates the chapter or section title, so a candidate equal to one of these is layout repetition of
// content that is present as a real heading elsewhere — excluding it loses nothing.
const HEADING_LABELS: ReadonlySet<string> = new Set(["title", "section_header"]);

// Punctuation stripped from BOTH ends while normalizing, so `— 89 —`, `| Chapter 5 |`, and `Chapter 5:`
// compare equal to their bare text. Interior punctuation is preserved: only the decorative frame a
// printer added around a running head is removed.
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

// A bare arabic folio (`89`), a lowercased roman folio (`iv`, `xii` — front matter), or an explicit
// `page 89` / `p. 89` locator. The roman form is a character-class shape rather than a canonical roman
// numeral because printers do emit non-canonical folios; it can only ever apply to a page_header /
// page_footer item of at most seven characters, so its reach over real prose is negligible.
const FOLIO_PATTERNS: readonly RegExp[] = [
  /^\d{1,4}$/,
  /^[ivxlcdm]{1,7}$/,
  /^(?:page|p\.?)\s*\d{1,4}$/
];

// How many distinct pages a candidate's normalized text must appear on before repetition alone proves it
// is a running head. Two is the minimum that distinguishes "printed on every page" from a one-off line
// that might be real content.
const REPEATED_PAGE_THRESHOLD = 2;

// A running head that EMBEDS its folio (#826): the printed page number sits at one edge, behind a
// separator a printer chose — `Chapter 2. Threads and Locks · 26`, `26 | Chapter 2`, `Formatting — 121`,
// `Comments: 53`, or plain whitespace. Anchored at the edges, so a number in the MIDDLE of a line is
// never touched, and a separator is REQUIRED, so `Locks26` keeps its digits.
//
// Only a bare 1-4 digit arabic run counts as the embedded token. The roman and `page 89` folio shapes
// stay whole-string-only: inside a longer line, `^[ivxlcdm]{1,7}$` matches ordinary English words
// (`mill`, `civil`, `mid`), and stripping one would delete real title text — the exact failure this
// module refuses to risk.
const TRAILING_EMBEDDED_FOLIO = /^(.+?)[\s\u00b7\u2022|\u2013\u2014:-]+(?:\d{1,4})$/u;
const LEADING_EMBEDDED_FOLIO = /^(?:\d{1,4})[\s\u00b7\u2022|\u2013\u2014:-]+(.+)$/u;

// Whitespace alone counts as a separator above by design (many running heads print as `Chapter 2 26`
// with no punctuation at all), and that is a KNOWN, ACCEPTED trade-off (#829): a short opener whose own
// last token happens to be a number strips exactly like a genuine embedded folio would, so `Chapter 3`
// and `Chapter 4` both reduce to the same `chapter` comparison key and collide with each other exactly
// as if one running head had repeated. From inside this module the two situations are indistinguishable
// — nothing here can tell "the same heading restated" apart from "two distinct short headings that
// happen to collide" — and tightening the separator (requiring punctuation, or a longer residue) would
// either reopen #826 or break the `Formatting. 121` case this suite pins below. The bookmark outline
// #828 exposes to the caller is the evidence that could resolve this safely (a collision candidate whose
// stripped text names a DIFFERENT, unclaimed outline entry per occurrence is almost certainly two real
// headings, not one repeat) — see #829 and this file's "known whitespace-separator collision" tests for
// why that narrowing is deliberately not attempted here.

// Why one candidate was excluded. Reported per item so the exclusion is auditable — a caller can show
// exactly which rule removed which line rather than a bare count.
//
// `claimed-outline-entry` is never produced by `decidePageFurniture` itself: this module has no notion
// of the PDF's bookmark outline, so it cannot know whether a once-seen candidate restates a heading
// printed elsewhere. A caller that also holds the outline applies this rule on top of this module's own
// decision, using `stripEmbeddedFolio` and `matchOutlineHeading` together — see `pdfCanonicalMapping.ts`.
export type PageFurnitureExclusionRule =
  | "empty"
  | "folio"
  | "repeated-across-pages"
  | "matches-heading"
  | "claimed-outline-entry";

// The minimum a furniture decision needs from a docling body item. Structural (not the contracts type)
// so this module stays dependency-free and testable without a full StructuredDocument.
export type PageFurnitureItem = Readonly<{
  label: string;
  pageNumber: number;
  text: string;
}>;

// One item's verdict: `body` keeps it as readable content (mapped normally by the caller), `excluded`
// drops it from the block hierarchy and carries the audit trail the caller records as evidence.
export type PageFurnitureDecision =
  | Readonly<{ kind: "body" }>
  | Readonly<{ kind: "excluded"; rule: PageFurnitureExclusionRule; normalizedText: string }>;

// Normalize a candidate for comparison: NFKC (so a full-width or ligature form compares equal), NBSP to
// a plain space, collapse runs of whitespace, trim, lowercase, then strip the decorative punctuation a
// printer frames a running head with. Exported because the same normalization defines what "the same
// running head" and "equals a heading" mean, and a caller recording evidence reports this exact form.
export function normalizePageFurnitureText(text: string): string {
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

function isFolioShape(normalized: string): boolean {
  return FOLIO_PATTERNS.some((pattern) => pattern.test(normalized));
}

// The comparison form of a candidate once at most ONE edge folio is removed, or the text unchanged when
// no edge token is safely removable. This rule DELETES content, so it strips at most one token, only at
// an edge, and only when what remains is still substantive — text carrying a letter that is not itself a
// folio. So `26` and `page 26 · 27` are left whole for the `folio` rule (or for no rule at all) rather
// than dissolving into nothing, and a residue of bare digits never becomes a repetition key.
//
// A line with a number at BOTH edges gives up only its trailing one — the common convention — and keeps
// the leading number inside the compared text. Taking a single token means such a line at worst matches
// nothing and stays readable: the conservative direction, a stray line kept over a title deleted.
//
// Exported so a caller composing this module with the outline matcher (`matchOutlineHeading`) can strip
// a candidate's own printed folio before comparing it against a bookmark title — see #828.
export function stripEmbeddedFolio(normalized: string): string {
  const trailing = TRAILING_EMBEDDED_FOLIO.exec(normalized);
  if (trailing) {
    const residue = trimEdgePunctuation(trailing[1]!);
    if (isSubstantiveResidue(residue)) {
      return residue;
    }
  }
  const leading = LEADING_EMBEDDED_FOLIO.exec(normalized);
  if (leading) {
    const residue = trimEdgePunctuation(leading[1]!);
    if (isSubstantiveResidue(residue)) {
      return residue;
    }
  }
  return normalized;
}

function isSubstantiveResidue(residue: string): boolean {
  return /\p{L}/u.test(residue) && !isFolioShape(residue);
}

export function isPageFurnitureCandidate(label: string): boolean {
  return FURNITURE_CANDIDATE_LABELS.has(label);
}

// Decide, for a WHOLE document's ordered top-level body items, which are page furniture. Whole-document
// (never per-page-range) evaluation is what makes repetition and heading-restatement detectable at all:
// a running head printed once per page only looks like furniture next to the other pages.
//
// Returns one decision per input item, in the SAME order, so the caller can zip decisions onto the body
// it already walks without re-deriving identity. First matching rule wins, in the order they are listed
// on `PageFurnitureExclusionRule`, so the reported reason is the most specific evidence available.
export function decidePageFurniture(
  body: readonly PageFurnitureItem[]
): readonly PageFurnitureDecision[] {
  const headings = new Set<string>();
  const pagesByComparisonText = new Map<string, Set<number>>();
  for (const item of body) {
    const normalized = normalizePageFurnitureText(item.text);
    if (HEADING_LABELS.has(item.label)) {
      headings.add(normalized);
      continue;
    }
    if (!isPageFurnitureCandidate(item.label)) {
      continue;
    }
    recordPage(pagesByComparisonText, stripEmbeddedFolio(normalized), item.pageNumber);
  }
  const index: FurnitureIndex = { headings, pagesByComparisonText };

  return body.map((item) => {
    if (!isPageFurnitureCandidate(item.label)) {
      return { kind: "body" };
    }
    const normalizedText = normalizePageFurnitureText(item.text);
    const rule = exclusionRule(normalizedText, index);
    return rule === null ? { kind: "body" } : { kind: "excluded", normalizedText, rule };
  });
}

// What the whole document proves about one candidate. Local to this module and read-only at the point of
// use, so no mutable index escapes the decision. Candidates are counted under their FOLIO-STRIPPED text,
// which is the text itself whenever there is no edge folio to remove: an exactly repeating running head
// is therefore counted exactly as before, while `<head> · 26` and `<head> · 38` — and a book that emits
// the head alone on some pages and combined on others — finally land in one bucket.
type FurnitureIndex = Readonly<{
  headings: ReadonlySet<string>;
  pagesByComparisonText: ReadonlyMap<string, ReadonlySet<number>>;
}>;

function recordPage(pages: Map<string, Set<number>>, text: string, pageNumber: number): void {
  const seen = pages.get(text) ?? new Set<number>();
  seen.add(pageNumber);
  pages.set(text, seen);
}

function exclusionRule(
  normalizedText: string,
  index: FurnitureIndex
): PageFurnitureExclusionRule | null {
  if (normalizedText.length === 0) {
    return "empty";
  }
  // Before any folio is stripped, so a candidate that is ONLY a folio is still reported as one.
  if (isFolioShape(normalizedText)) {
    return "folio";
  }
  const comparisonText = stripEmbeddedFolio(normalizedText);
  // The index was built from every candidate's comparison text, so this lookup always hits; the empty
  // fallback keeps the type total.
  /* v8 ignore next */
  const pageCount = index.pagesByComparisonText.get(comparisonText)?.size ?? 0;
  if (pageCount >= REPEATED_PAGE_THRESHOLD) {
    return "repeated-across-pages";
  }
  // Both forms are tried: a heading may itself end in a number (`Rule 34`), which the stripped form would
  // no longer equal, and a running head may carry a folio the heading does not.
  if (index.headings.has(normalizedText) || index.headings.has(comparisonText)) {
    return "matches-heading";
  }
  return null;
}
