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

// The lookup route query: a non-empty (trimmed) term and a supported work language (English
// or Chinese), so Chinese selections route to the CC-CEDICT provider. The term is trimmed
// in-place so callers downstream receive the cleaned value.
export const lookupRequestSchema = z
  .object({
    language: z.enum(workLanguages),
    term: z.string().trim().min(1, { message: "term must be non-empty." })
  })
  .strict();

export type LookupRequest = z.infer<typeof lookupRequestSchema>;

export function parseLookupRequest(value: unknown): LookupRequest {
  return lookupRequestSchema.parse(value);
}
