import { documentReadableText, parseDocument, serializeDocument } from "./document.js";
import type { DocumentNodeJSON } from "./document.js";
import { projectNoteMaterial } from "./noteMaterial.js";
import { codePointLength } from "./nearMatchScore.js";

// The read-only eligibility gate + relaxed-key + protected-evidence projection for high-precision near-Note
// matching (#713). Fuzzy similarity is a conservative REVIEW signal, never identity: it runs only inside a
// declared, measured scope, and this module draws that scope. A Note is eligible only when it is plain
// English prose small enough that character edit distance means something; everything else — a single word,
// non-ASCII or mixed scripts, links, code, headings, lists, tables, images, footnotes, or any unknown node —
// is UNSUPPORTED and projects to `null`, so the matcher stays silent rather than warn falsely.
//
// Like the exact material projection it is a PURE, deterministic, browser-safe derivation with no Node APIs,
// so the write boundary, the one-time backfill, and the owner-scoped query all COMPOSE this single projection
// instead of re-deriving eligibility per surface. Only the relaxed key + its code-point length are persisted;
// the case-sensitive key, exact material, and protected evidence are recomputed at match time (the persisted
// key is only a length-banded lookup accelerator, never the identity decision).

// A near-eligible document is plain English prose: only the root, paragraphs, and text, with at most bold or
// italic emphasis (which the exact projection already treats as non-content). ANY other node — heading, list,
// table, code block, image, footnote, blockquote, or an unknown/future opaque node — makes it unsupported.
const ELIGIBLE_NODE_TYPES: ReadonlySet<string> = new Set(["doc", "paragraph", "text"]);
const ELIGIBLE_MARK_TYPES: ReadonlySet<string> = new Set(["bold", "italic"]);

// The relaxed key admits 2–40 word tokens and 8–240 code points: below two tokens or eight code points there
// is too little material for an edit to be conservative (a single word can flip meaning), and above the upper
// bounds the material is a passage, not a card-sized note.
const MIN_TOKENS = 2;
const MAX_TOKENS = 40;
const MIN_CODE_POINTS = 8;
const MAX_CODE_POINTS = 240;

// Renderer-equivalent quote, apostrophe, and dash glyphs that a reader perceives as the SAME mark, collapsed
// to one ASCII representative BEFORE eligibility and evidence are read. This is why a smart-quote or en-dash
// variant is a near-match POSITIVE (same material) rather than a spurious symbol difference: the equivalence
// is applied everywhere downstream, so `“hello”` and `"hello"` carry identical keys and identical symbol
// evidence. Case is deliberately NOT folded here — the case-sensitive form is what separates an ordinary
// capitalized word from an acronym.
const CHARACTER_EQUIVALENTS: ReadonlyMap<string, string> = new Map([
  ["\u201C", '"'],
  ["\u201D", '"'],
  ["\u201E", '"'],
  ["\u201F", '"'],
  ["\u00AB", '"'],
  ["\u00BB", '"'],
  ["\u2033", '"'],
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201A", "'"],
  ["\u201B", "'"],
  ["\u2032", "'"],
  ["\u0060", "'"],
  ["\u00B4", "'"],
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2015", "-"],
  ["\u2212", "-"]
]);

// The ASCII representatives that quote/apostrophe/dash glyphs collapse to. Because the relaxed normalization
// declares these renderer-equivalent, they are punctuation a reader does not perceive as an operator — a
// smart-quote, straight-quote, hyphen, or spaced variant is a near-match POSITIVE. They are therefore excluded
// from the protected symbol multiset, while genuine operators (`= + , ; % :: -> # _`) remain protected.
const NORMALIZED_PUNCTUATION: ReadonlySet<string> = new Set(CHARACTER_EQUIVALENTS.values());
// a pair, so `is safe` can never collapse into `is not safe`. `n't` (from a normalized contraction such as
// `don't`) is detected separately below.
const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "never",
  "neither",
  "nor",
  "without"
]);

// The protected evidence of a note's material — the facts fuzzy distance must never smear together. Each field
// is a canonical, order-independent string so two notes' evidence compares by simple equality, and any single
// field differing vetoes the pair. Persisted nowhere; recomputed from the body at match time.
export type ProtectedEvidence = Readonly<{
  // Sorted, case-folded digit-bearing tokens: numbers, decimals, signed/percent/ordinal/date/version forms,
  // digit-adjacent units, and mixed letter/digit identifiers (`ipv4`) all carry a digit and land here.
  numbers: string;
  // Sorted multiset of operator/punctuation characters (non-alphanumeric, non-space) EXCLUDING the renderer-
  // normalized quote/apostrophe/dash marks: genuine operators and the code-like `_ :: -> # +` and protocol
  // separators, so `F=ma`/`F+ma` differ here while `well known`/`well-known` do not.
  symbols: string;
  // Sorted negation tokens (`no not never neither nor without` and `n't`).
  negations: string;
  // Sorted, CASE-SENSITIVE acronym/identifier tokens: all-caps runs (`US`, `IP`), camel/Pascal case
  // (`IPv4`, `readIndex`). Ordinary sentence capitalization is not an identifier, so `Apple`/`apple` differ
  // only by case (handled by the case-only exclusion), while `US`/`us` differ in this evidence.
  identifiers: string;
}>;

// A note's near-match projection: the persisted relaxed key + its code-point length, plus the recomputed-only
// case-sensitive key, exact material projection, and protected evidence the matcher needs to exclude exact
// and case-only pairs and to veto protected differences.
export type NearMatchProjection = Readonly<{
  caseSensitiveKey: string;
  codePointLength: number;
  exactMaterial: string;
  protectedEvidence: ProtectedEvidence;
  relaxedKey: string;
}>;

// The persisted slice of the projection: exactly the non-unique relaxed key + its code-point length written
// on eligible notes (unsupported notes carry nulls). Split out so the write boundary and backfill persist
// only these two columns.
export type NearMatchKey = Readonly<{ codePointLength: number; relaxedKey: string }>;

// Whether every node is an eligible prose node carrying only eligible emphasis marks.
function isStructurallyEligible(node: DocumentNodeJSON): boolean {
  if (!ELIGIBLE_NODE_TYPES.has(node.type)) {
    return false;
  }
  for (const mark of node.marks ?? []) {
    if (!ELIGIBLE_MARK_TYPES.has(mark.type)) {
      return false;
    }
  }
  return (node.content ?? []).every(isStructurallyEligible);
}

// NFKC-normalize, then collapse each renderer-equivalent quote/apostrophe/dash to its ASCII representative.
// Iterating with `for..of` walks code points so an astral glyph is mapped or preserved whole.
function normalizeCharacters(text: string): string {
  let normalized = "";
  for (const character of text.normalize("NFKC")) {
    normalized += CHARACTER_EQUIVALENTS.get(character) ?? character;
  }
  return normalized;
}

// Collapse every whitespace run to a single space and trim the ends — spacing is never material for prose.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Fold only ASCII A–Z to lower case; eligible material is ASCII-only, so this is the complete case fold while
// leaving any (rejected) non-ASCII untouched.
function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// Whether every code point is ASCII (< 0x80): after quote/dash normalization any surviving non-ASCII letter,
// CJK character, emoji, or exotic symbol makes the note unsupported.
function isAsciiOnly(text: string): boolean {
  for (const character of text) {
    if (character.codePointAt(0)! > 0x7f) {
      return false;
    }
  }
  return true;
}

// Extract the protected evidence from the case-sensitive relaxed key. Numbers, symbols, and negations are
// read case-insensitively; identifiers keep their case because case IS the signal there.
function protectedEvidence(caseSensitiveKey: string): ProtectedEvidence {
  const tokens = caseSensitiveKey.split(" ");
  const numbers: string[] = [];
  const identifiers: string[] = [];
  for (const token of tokens) {
    if (/[0-9]/.test(token)) {
      numbers.push(token.toLowerCase());
    }
    // An acronym (2+ upper-case letters in a row) or a camel/Pascal-case transition marks a deliberate
    // identifier; a merely sentence-initial capital does not.
    if (/[A-Z]{2,}/.test(token) || /[a-z][A-Z]/.test(token) || /[A-Z][a-z]+[A-Z]/.test(token)) {
      identifiers.push(token);
    }
  }
  const folded = foldAsciiCase(caseSensitiveKey);
  const negations: string[] = [];
  for (const match of folded.matchAll(/\b(?:no|not|never|neither|nor|without)\b/g)) {
    negations.push(match[0]);
  }
  for (const _ of folded.matchAll(/[a-z]+n't/g)) {
    negations.push("n't");
  }
  const symbols = [...caseSensitiveKey]
    .filter(
      (character) => /[^A-Za-z0-9 ]/.test(character) && !NORMALIZED_PUNCTUATION.has(character)
    )
    .sort();

  return {
    identifiers: identifiers.sort().join("\u0000"),
    negations: negations
      .filter((word) => NEGATION_WORDS.has(word) || word === "n't")
      .sort()
      .join(" "),
    numbers: numbers.sort().join(" "),
    symbols: symbols.join("")
  };
}

// Project a note body to its near-match facets, or `null` when the note is UNSUPPORTED. A document is
// eligible only when it validates, is structurally plain prose with at most bold/italic, holds 2–40 word
// tokens and 8–240 ASCII code points after normalization, and carries at least one letter. An invalid,
// non-prose, empty, oversized, single-word, or non-ASCII body yields `null` — the matcher's silence.
//
// The relaxed key (persisted, scored) is NFKC + quote/dash normalized + whitespace-collapsed + ASCII
// case-folded; the case-sensitive key is the same WITHOUT the case fold, so the matcher can separate a
// case-only difference from an ordinary edit. The exact material reuses the #711 projection so the matcher can
// exclude a truly-identical pair that the exact review already owns.
export function projectNearMatch(json: unknown): NearMatchProjection | null {
  let serialized: DocumentNodeJSON;
  try {
    serialized = serializeDocument(parseDocument(json));
  } catch {
    return null;
  }

  if (!isStructurallyEligible(serialized)) {
    return null;
  }

  const normalized = collapseWhitespace(normalizeCharacters(documentReadableText(serialized)));
  if (!isAsciiOnly(normalized)) {
    return null;
  }

  const tokens = normalized.split(" ");
  const length = codePointLength(normalized);
  const hasLetter = /[A-Za-z]/.test(normalized);
  if (
    tokens.length < MIN_TOKENS ||
    tokens.length > MAX_TOKENS ||
    length < MIN_CODE_POINTS ||
    length > MAX_CODE_POINTS ||
    !hasLetter
  ) {
    return null;
  }

  return {
    caseSensitiveKey: normalized,
    codePointLength: length,
    exactMaterial: projectNoteMaterial(serialized),
    protectedEvidence: protectedEvidence(normalized),
    relaxedKey: foldAsciiCase(normalized)
  };
}

// The persisted key slice, or `null` when unsupported: exactly the columns the notes table stores.
export function projectNearMatchKey(json: unknown): NearMatchKey | null {
  const projection = projectNearMatch(json);
  return projection === null
    ? null
    : { codePointLength: projection.codePointLength, relaxedKey: projection.relaxedKey };
}
