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

// A faithful tidy only DROPS words (fillers, false starts, verbatim repeats) and lightly REORDERS them;
// it never adds, upgrades, or substitutes a word. So the tidied word multiset must be contained in the
// raw word multiset. `isFaithfulTidy` is the deterministic guard the seam uses to reject a model rewrite
// that violates the "tidy, not polish" contract and fall back to the raw transcript, keeping the diary a
// trustworthy learner-history signal (#462) — the prompt alone cannot guarantee a local model obeys it.
//
// Language-agnostic tokenization: space-delimited scripts tokenize into letter/number runs; CJK and
// Japanese/Korean characters (which carry no spaces) each count as one token, so a dropped filler still
// reduces a count and a substituted character is still caught. Comparison is case-insensitive.
const TIDY_WORD_PATTERN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]|[\p{L}\p{N}]+/gu;

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
  for (const [word, count] of tidyWordCounts(tidied)) {
    if ((rawCounts.get(word) ?? 0) < count) {
      return false;
    }
  }
  return true;
}
