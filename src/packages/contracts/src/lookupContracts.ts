import { workLanguages } from "@whetstone/domain";
import { z } from "zod";

// One normalized sense: a single definition with its own examples and synonyms. This is the
// shared, source-agnostic shape the reader renders, so the client never depends on a
// provider's wire format (Wiktionary, WordNet, or CC-CEDICT).
export const dictionarySenseSchema = z
  .object({
    definition: z.string(),
    examples: z.array(z.string()),
    synonyms: z.array(z.string())
  })
  .strict();

export type DictionarySense = z.infer<typeof dictionarySenseSchema>;

// Senses grouped under one part of speech. `partOfSpeech` is optional because some sources
// (CC-CEDICT) carry no part-of-speech tagging.
export const dictionaryPartOfSpeechSchema = z
  .object({
    partOfSpeech: z.string().optional(),
    senses: z.array(dictionarySenseSchema)
  })
  .strict();

export type DictionaryPartOfSpeech = z.infer<typeof dictionaryPartOfSpeechSchema>;

// One pronunciation: an IPA (or pinyin) transcription, with an optional audio URL.
export const dictionaryPronunciationSchema = z
  .object({
    audio: z.string().optional(),
    ipa: z.string()
  })
  .strict();

export type DictionaryPronunciation = z.infer<typeof dictionaryPronunciationSchema>;

// One headword's enriched entry, composed by role from the available sources: pronunciations
// and etymology from Wiktionary, senses grouped by part of speech (Wiktionary primary, WordNet
// fallback), synonyms from WordNet (∪ Wiktionary). `sources` carries the attribution strings of
// every contributing source so the reader can show required credit.
export const dictionaryEntrySchema = z
  .object({
    etymology: z.string().optional(),
    headword: z.string(),
    partsOfSpeech: z.array(dictionaryPartOfSpeechSchema),
    pronunciations: z.array(dictionaryPronunciationSchema),
    sources: z.array(z.string())
  })
  .strict();

export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>;

// The route result is a discriminated union: a found entry or an explicit not-found, so the
// client renders an empty state instead of guessing from a null body. Attribution now lives
// inside the entry's `sources`, so there is no separate top-level attribution field.
export const lookupResponseSchema = z.discriminatedUnion("found", [
  z.object({ entry: dictionaryEntrySchema, found: z.literal(true) }).strict(),
  z.object({ found: z.literal(false) }).strict()
]);

export type LookupResponse = z.infer<typeof lookupResponseSchema>;

export function parseLookupResponse(value: unknown): LookupResponse {
  return lookupResponseSchema.parse(value);
}

// Lookup sources the reader can show as independent tabs: WordNet (offline, instant) and Wiktionary
// (rich, networked) for English; for Chinese, 萌典/moedict (Chinese definitions, primary),
// zh.Wiktionary (rich classical senses/古義/etymology, secondary), and CC-CEDICT (English glosses,
// tertiary). Each tab fetches its source alone so one being slow/down/empty never freezes or empties
// the popover (#196).
export const lookupSourceIds = [
  "wordnet",
  "wiktionary",
  "cedict",
  "moedict",
  "zhwiktionary",
  "llm"
] as const;

export type LookupSourceId = (typeof lookupSourceIds)[number];

const sourceLabels: Readonly<Record<LookupSourceId, string>> = {
  cedict: "CC-CEDICT",
  llm: "AI 解释",
  moedict: "萌典",
  wiktionary: "Wiktionary",
  wordnet: "WordNet",
  zhwiktionary: "中文維基詞典"
};

export function lookupSourceLabel(id: LookupSourceId): string {
  return sourceLabels[id];
}

const sourcesByLanguage: Readonly<Record<string, ReadonlyArray<LookupSourceId>>> = {
  en: ["wordnet", "wiktionary"],
  "zh-CN": ["moedict", "zhwiktionary", "cedict", "llm"],
  "zh-TW": ["moedict", "zhwiktionary", "cedict", "llm"]
};

// The ordered tabs to fetch for a work language; the first is the default. English leads with the
// always-resolving offline WordNet; Chinese leads with 萌典's Chinese definitions (#272), then
// zh.Wiktionary's richer classical senses, then CC-CEDICT's English glosses, with the optional
// local-LLM "AI 解释" contextual aid (#341) LAST — dictionaries lead and the reader opens the AI tab
// deliberately (#306 auto-selects the first non-empty tab, never the trailing LLM).
export function lookupSourcesForLanguage(language: string): ReadonlyArray<LookupSourceId> {
  return sourcesByLanguage[language] ?? [];
}

// The lookup route query: a non-empty (trimmed) term and a supported work language (English
// or Chinese), so Chinese selections route to the CC-CEDICT provider. The term is trimmed
// in-place so callers downstream receive the cleaned value. `context` is the selection's containing
// block text, sent only for the local-LLM source (#341) so it can gloss the term IN CONTEXT; it is
// optional (existing sources/tests are unaffected) and length-bounded so a huge block cannot bloat the
// request (the client also truncates before sending).
export const lookupRequestSchema = z
  .object({
    context: z.string().max(4000).optional(),
    language: z.enum(workLanguages),
    source: z.enum(lookupSourceIds),
    term: z.string().trim().min(1, { message: "term must be non-empty." })
  })
  .strict();

export type LookupRequest = z.infer<typeof lookupRequestSchema>;

export function parseLookupRequest(value: unknown): LookupRequest {
  return lookupRequestSchema.parse(value);
}
