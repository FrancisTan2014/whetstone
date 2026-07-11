import type { DictionaryEntry } from "@whetstone/contracts";

// The offline gloss autofill (#526): turn a headword into a short "back" for a recall item, drawn ONLY
// from the bundled offline dictionaries (WordNet for English, CC-CEDICT for Chinese). Offline-only is
// the contract — enroll must never block on the network, so a not-found term simply yields null and the
// item keeps the #525 reveal-time floor. This module is pure: it composes two entry lookups and extracts
// a bounded definition, so it unit-tests without WordNet, CC-CEDICT, React, Fastify, or a database.

// One dictionary source reduced to the single call the glosser needs: a headword in, a normalized entry
// (or null when unknown) out. The production lookups take extra options (language/context); the wiring
// in index.ts adapts them to this narrower shape.
export type EntryLookup = (term: string) => Promise<DictionaryEntry | null>;

export type OfflineGlossSources = Readonly<{
  english: EntryLookup;
  chinese: EntryLookup;
}>;

// A gloss is a compact aid, not an article: bound its length so one verbose dictionary sense cannot
// bloat the stored back. Beyond this, truncate with an ellipsis (kept within the bound).
const MAX_GLOSS_LENGTH = 200;

// Detect a Chinese term by script: any Han ideograph routes to CC-CEDICT; everything else to WordNet.
// This mirrors the reader's language-by-script selection without needing the caller to tag a language.
export function isChineseText(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

// Take the first sense of the first part of speech as the gloss — the entry's most salient definition.
// If a part-of-speech label is present, prefix it (e.g. "noun: a lessening"). Trim, and bound the
// length. An entry with no usable definition (missing, or blank) yields null so the caller stores no
// back rather than an empty string.
export function extractGloss(entry: DictionaryEntry | null): string | null {
  const partOfSpeech = entry?.partsOfSpeech[0];
  const definition = partOfSpeech?.senses[0]?.definition.trim();
  if (definition === undefined || definition.length === 0) {
    return null;
  }

  const label = partOfSpeech?.partOfSpeech?.trim();
  const composed = label !== undefined && label.length > 0 ? `${label}: ${definition}` : definition;

  return composed.length > MAX_GLOSS_LENGTH
    ? `${composed.slice(0, MAX_GLOSS_LENGTH - 1).trimEnd()}\u2026`
    : composed;
}

// Compose the two offline sources into the `resolveOfflineGloss` seam the Memory deposit paths depend on:
// trim the term, pick the dictionary by script, and extract a bounded gloss. Fails soft in every
// direction — a blank term, an unknown headword, or even a throwing lookup all resolve to null so
// capture is never blocked (an unglossable prompt is simply saved as a draft) and no error escapes.
export function createOfflineGloss(
  sources: OfflineGlossSources
): (text: string) => Promise<string | null> {
  return async (text) => {
    const term = text.trim();
    if (term.length === 0) {
      return null;
    }

    const lookup = isChineseText(term) ? sources.chinese : sources.english;
    try {
      return extractGloss(await lookup(term));
    } catch {
      return null;
    }
  };
}
