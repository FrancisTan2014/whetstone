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
