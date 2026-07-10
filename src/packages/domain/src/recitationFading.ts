// Progressive fading for recitation passage practice (#579): the pure, render-time projection that
// removes visual support from a passage before the learner attempts it from memory. Given the canonical
// passage text and a chosen support level, this returns a structured list of lines and segments — each
// segment either shown verbatim or masked (a length only, never the hidden characters). The canonical
// text is never changed: fading is a projection over it, so copy, accessibility text, search, stored
// content, anchors, and the revealed answer always use the unchanged source. No persistence, scheduling,
// DB, network, or UI here.

// The four deterministic support levels, ordered most-support to least (#579). `full` shows the whole
// passage as a scaffold; `reduced` shows the first half of each clause and masks the rest; `first`
// shows only each clause's first unit (character or word); `hidden` shows none of the target — the
// review then falls back to the existing external cue. The learner steps down this ladder; Whetstone
// never auto-lowers it.
export const recitationSupportLevels = ["full", "reduced", "first", "hidden"] as const;

export type RecitationSupportLevel = (typeof recitationSupportLevels)[number];

const supportLevelSet: ReadonlySet<unknown> = new Set(recitationSupportLevels);

export function isRecitationSupportLevel(value: unknown): value is RecitationSupportLevel {
  return supportLevelSet.has(value);
}

// The support level a freshly seeded passage opens at: full visual support, which the learner then
// removes at their own pace (#579). Persisted per passage as the remembered preference.
export const DEFAULT_RECITATION_SUPPORT_LEVEL: RecitationSupportLevel = "full";

// Whether a support level reveals any of the target text at all. `hidden` alone shows none of it (the
// review renders only the external cue); the other three render a projection of the target.
export function supportLevelShowsTarget(
  level: RecitationSupportLevel
): level is Exclude<RecitationSupportLevel, "hidden"> {
  return level !== "hidden";
}

// The three levels that actually project the target text (everything but `hidden`).
export type RecitationVisibleSupportLevel = Exclude<RecitationSupportLevel, "hidden">;

// One rendered piece of a projected line: text shown verbatim, or a masked run described only by how
// many characters it hides. A masked segment never carries the hidden text, so an accessibility layer
// can announce "hidden text" instead of leaking a misleading partial sentence.
export type SupportSegment =
  | Readonly<{ kind: "shown"; text: string }>
  | Readonly<{ kind: "masked"; length: number }>;

export type SupportLine = ReadonlyArray<SupportSegment>;

// The passage projected for display at a support level: one entry per source line (line breaks and
// blank lines preserved as paragraph structure), each a sequence of shown/masked segments.
export type SupportProjection = Readonly<{ lines: ReadonlyArray<SupportLine> }>;

// Clause-ending punctuation the segmentation splits on (CJK and ASCII sentence/clause marks). The
// delimiter stays visible and attached to its clause. Other punctuation (quotes, brackets, apostrophes,
// hyphens) is preserved too but never splits a clause and is never masked.
const CLAUSE_DELIMITERS: ReadonlySet<string> = new Set([..."、。，．；：！？…⋯―—–,.;:!?"]);

const OTHER_PUNCTUATION = /\p{P}/u;
const WHITESPACE = /\s/u;
const HAN = /\p{sc=Han}/u;

type CharClass = "delimiter" | "punctuation" | "whitespace" | "content";

function classifyChar(char: string): CharClass {
  if (CLAUSE_DELIMITERS.has(char)) {
    return "delimiter";
  }
  if (WHITESPACE.test(char)) {
    return "whitespace";
  }
  if (OTHER_PUNCTUATION.test(char)) {
    return "punctuation";
  }
  return "content";
}

// Split a single line (no newlines) into clauses. Each clause is the run of characters up to and
// including the next clause delimiter; a trailing run without a delimiter is a final clause. Empty
// input yields no clauses. Iterates by code point so surrogate pairs (emoji) are never split.
function splitIntoClauses(line: string): string[] {
  const clauses: string[] = [];
  let current = "";
  for (const char of line) {
    current += char;
    if (CLAUSE_DELIMITERS.has(char)) {
      clauses.push(current);
      current = "";
    }
  }
  if (current.length > 0) {
    clauses.push(current);
  }
  return clauses;
}

// How many leading units (characters or words) stay visible for a clause of `unitCount` units at a
// visible level. `reduced` keeps the first half (rounded up, so an odd clause keeps its middle unit);
// `first` keeps one; `full` keeps them all.
function shownUnitCount(unitCount: number, level: RecitationVisibleSupportLevel): number {
  if (level === "full") {
    return unitCount;
  }
  if (level === "first") {
    return Math.min(1, unitCount);
  }
  return Math.ceil(unitCount / 2);
}

// Project a Chinese (Han-containing) clause by character: each content character beyond the shown count
// is masked; delimiters, other punctuation, and whitespace are always shown in place.
function projectCjkClause(
  chars: readonly string[],
  level: RecitationVisibleSupportLevel
): SupportSegment[] {
  const contentCount = chars.filter((char) => classifyChar(char) === "content").length;
  const shown = shownUnitCount(contentCount, level);
  const segments: SupportSegment[] = [];
  let contentIndex = 0;
  for (const char of chars) {
    if (classifyChar(char) === "content") {
      if (contentIndex < shown) {
        pushShown(segments, char);
      } else {
        pushMasked(segments, [...char].length);
      }
      contentIndex += 1;
    } else {
      pushShown(segments, char);
    }
  }
  return segments;
}

type Atom = Readonly<{ kind: "word"; text: string }> | Readonly<{ kind: "fixed"; text: string }>;

// Break a whitespace-delimited clause into atoms: word tokens (maximal runs of content characters) and
// fixed runs (whitespace and punctuation, which are always shown). Splitting words on punctuation keeps
// every delimiter, quote, and space visible, so reduction only ever hides real words.
function atomizeClause(chars: readonly string[]): Atom[] {
  const atoms: Atom[] = [];
  let word = "";
  let fixed = "";
  const flushWord = (): void => {
    if (word.length > 0) {
      atoms.push({ kind: "word", text: word });
      word = "";
    }
  };
  const flushFixed = (): void => {
    if (fixed.length > 0) {
      atoms.push({ kind: "fixed", text: fixed });
      fixed = "";
    }
  };
  for (const char of chars) {
    if (classifyChar(char) === "content") {
      flushFixed();
      word += char;
    } else {
      flushWord();
      fixed += char;
    }
  }
  flushWord();
  flushFixed();
  return atoms;
}

// Project a whitespace-delimited (non-Han) clause by word: the first N words stay visible, later words
// are masked whole; whitespace and punctuation are always shown, preserving spacing and punctuation.
function projectTokenClause(
  chars: readonly string[],
  level: RecitationVisibleSupportLevel
): SupportSegment[] {
  const atoms = atomizeClause(chars);
  const wordCount = atoms.filter((atom) => atom.kind === "word").length;
  const shown = shownUnitCount(wordCount, level);
  const segments: SupportSegment[] = [];
  let wordIndex = 0;
  for (const atom of atoms) {
    if (atom.kind === "word") {
      if (wordIndex < shown) {
        pushShown(segments, atom.text);
      } else {
        pushMasked(segments, [...atom.text].length);
      }
      wordIndex += 1;
    } else {
      pushShown(segments, atom.text);
    }
  }
  return segments;
}

function pushShown(segments: SupportSegment[], text: string): void {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.kind === "shown") {
    segments[segments.length - 1] = { kind: "shown", text: last.text + text };
    return;
  }
  segments.push({ kind: "shown", text });
}

function pushMasked(segments: SupportSegment[], length: number): void {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.kind === "masked") {
    segments[segments.length - 1] = { kind: "masked", length: last.length + length };
    return;
  }
  segments.push({ kind: "masked", length });
}

// Choose per clause how to reduce it — by character when the clause contains Han script, otherwise by
// whitespace token — so a mixed-script passage fades each clause in its own idiom rather than corrupting
// characters (e.g. cutting an English word mid-letter or a Chinese line by spaces it does not have).
function projectClause(clause: string, level: RecitationVisibleSupportLevel): SupportSegment[] {
  const chars = [...clause];
  return HAN.test(clause) ? projectCjkClause(chars, level) : projectTokenClause(chars, level);
}

function projectLine(line: string, level: RecitationVisibleSupportLevel): SupportLine {
  if (level === "full") {
    return line.length === 0 ? [] : [{ kind: "shown", text: line }];
  }
  const segments: SupportSegment[] = [];
  for (const clause of splitIntoClauses(line)) {
    for (const segment of projectClause(clause, level)) {
      if (segment.kind === "shown") {
        pushShown(segments, segment.text);
      } else {
        pushMasked(segments, segment.length);
      }
    }
  }
  return segments;
}

// Project a canonical passage for display at a visible support level. Line breaks (and blank lines) are
// preserved as separate lines; within each line, clauses are faded per their script. The canonical text
// is only read, never mutated — reveal, copy, and search continue to use the original source.
export function projectRecitationSupport(
  canonicalText: string,
  level: RecitationVisibleSupportLevel
): SupportProjection {
  const lines = canonicalText.split("\n").map((line) => projectLine(line, level));
  return { lines };
}
