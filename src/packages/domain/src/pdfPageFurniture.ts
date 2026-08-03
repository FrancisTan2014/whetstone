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

// Why one candidate was excluded. Reported per item so the exclusion is auditable — a caller can show
// exactly which rule removed which line rather than a bare count.
export type PageFurnitureExclusionRule =
  | "empty"
  | "folio"
  | "repeated-across-pages"
  | "matches-heading";

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
  const candidatePages = new Map<string, Set<number>>();
  for (const item of body) {
    const normalized = normalizePageFurnitureText(item.text);
    if (HEADING_LABELS.has(item.label)) {
      headings.add(normalized);
      continue;
    }
    if (!isPageFurnitureCandidate(item.label)) {
      continue;
    }
    const pages = candidatePages.get(normalized) ?? new Set<number>();
    pages.add(item.pageNumber);
    candidatePages.set(normalized, pages);
  }

  return body.map((item) => {
    if (!isPageFurnitureCandidate(item.label)) {
      return { kind: "body" };
    }
    const normalizedText = normalizePageFurnitureText(item.text);
    const rule = exclusionRule(normalizedText, candidatePages, headings);
    return rule === null ? { kind: "body" } : { kind: "excluded", normalizedText, rule };
  });
}

function exclusionRule(
  normalizedText: string,
  candidatePages: ReadonlyMap<string, ReadonlySet<number>>,
  headings: ReadonlySet<string>
): PageFurnitureExclusionRule | null {
  if (normalizedText.length === 0) {
    return "empty";
  }
  if (isFolioShape(normalizedText)) {
    return "folio";
  }
  // `candidatePages` was built from every candidate, so the lookup always hits for a candidate's own
  // normalized text; the empty fallback keeps the type total.
  /* v8 ignore next */
  const pageCount = candidatePages.get(normalizedText)?.size ?? 0;
  if (pageCount >= REPEATED_PAGE_THRESHOLD) {
    return "repeated-across-pages";
  }
  if (headings.has(normalizedText)) {
    return "matches-heading";
  }
  return null;
}
