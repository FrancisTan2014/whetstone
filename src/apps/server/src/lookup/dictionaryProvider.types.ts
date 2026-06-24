// The DictionaryProvider seam: vocabulary-lookup sources implement this so callers (and,
// later, the reader UI) depend only on this normalized shape — never on a source's wire
// format, transport, or caching. No implementations live here; the first provider arrives
// with the English-lookup feature that depends on this foundation.

export type NormalizedSense = Readonly<{
  example?: string;
  gloss: string;
  partOfSpeech?: string;
}>;

export type NormalizedEntry = Readonly<{
  headword: string;
  pronunciation?: string;
  senses: ReadonlyArray<NormalizedSense>;
}>;

export interface DictionaryProvider {
  // Resolves to the normalized entry, or null when the term has no entry for the language.
  lookup(term: string, language: string): Promise<NormalizedEntry | null>;
}
