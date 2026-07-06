// The diary "tidy" prompt (#246). Tidy is NOT polish: it drops fillers/false starts/repeats and lightly
// reorders for readability while PRESERVING the speaker's exact wording, meaning, and voice — never
// upgrading vocabulary, "correcting" to native phrasing, or translating (PRODUCT.md "Tidy, not polish").
// Polishing would erase the raw production signal the coach reads. Pure string-building so the invariant
// is asserted in a test; the actual model call is an injected seam.

// The instruction lines the prompt must always carry. Exported so a test can assert the invariant
// survives any future prompt edit (drop fillers, preserve wording/meaning/voice, never upgrade/translate).
export const diaryTidyInstructions: ReadonlyArray<string> = [
  "You are tidying a spoken diary entry. Tidy, do NOT polish.",
  "Drop filler words, false starts, and verbatim repetitions, and lightly reorder only for readability.",
  "PRESERVE the speaker's exact wording, meaning, and voice.",
  "NEVER upgrade vocabulary, correct grammar to native phrasing, rephrase, or translate.",
  "Keep the original language exactly as spoken — any language is fine.",
  "Reply with ONLY the tidied entry text, no preamble, quotes, or commentary."
];

// Build the tidy prompt for a transcript: the fixed invariant instructions, then the transcript to tidy.
export function buildDiaryTidyPrompt(transcript: string): string {
  return [...diaryTidyInstructions, "", `Transcript:\n${transcript}`].join("\n");
}

// A faithful tidy only DROPS fillers/false starts/repeats and lightly REORDERS the learner's own words;
// it never adds, upgrades, or substitutes a word, and it never deletes a word that carries meaning.
// `isFaithfulTidy` is the deterministic guard the seam uses to reject a model rewrite that violates the
// "tidy, not polish" contract and fall back to the raw transcript, keeping the diary a trustworthy
// learner-history signal (#462) — the prompt alone cannot guarantee a local model obeys it. Two rules:
//
//   1. No addition/substitution: the tidied word multiset must be contained in the raw word multiset.
//   2. No meaning-reversing deletion: protected NEGATORS (not/never/no/… and `n't` contractions) must be
//      preserved in full — deleting one flips the sentence ("I did not finish" -> "I did finish"), which a
//      subset check alone would wrongly accept.
//
// Language-agnostic tokenization: space-delimited scripts tokenize into letter/number runs (keeping an
// internal apostrophe so "don't" stays one token); CJK and Japanese/Korean characters (which carry no
// spaces) each count as one token, so a dropped filler still reduces a count and a substituted character
// is still caught. Comparison is case-insensitive.
const TIDY_WORD_PATTERN =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

// Negation words whose deletion reverses meaning, so a faithful tidy must keep every one. The `n't`
// contractions (don't, isn't, won't, can't, …) are matched by suffix rather than enumerated.
const PROTECTED_NEGATORS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "no",
  "none",
  "nor",
  "neither",
  "nobody",
  "nothing",
  "nowhere",
  "without",
  "cannot"
]);

function isProtectedNegator(word: string): boolean {
  return PROTECTED_NEGATORS.has(word) || /n['’]t$/u.test(word);
}

function tidyWordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(TIDY_WORD_PATTERN)) {
    const word = match[0];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

export function isFaithfulTidy(raw: string, tidied: string): boolean {
  const rawCounts = tidyWordCounts(raw);
  const tidiedCounts = tidyWordCounts(tidied);

  // Rule 1 — no added/substituted words: every tidied token must be within the raw multiset.
  for (const [word, count] of tidiedCounts) {
    if ((rawCounts.get(word) ?? 0) < count) {
      return false;
    }
  }

  // Rule 2 — no dropped negation: every protected negator must survive in full.
  for (const [word, count] of rawCounts) {
    if (isProtectedNegator(word) && (tidiedCounts.get(word) ?? 0) !== count) {
      return false;
    }
  }

  return true;
}
