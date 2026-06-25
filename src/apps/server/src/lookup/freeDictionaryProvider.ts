import type {
  DictionaryPartOfSpeech,
  DictionaryPronunciation,
  DictionarySense
} from "@whetstone/contracts";

import type { HttpClient } from "./httpClient.js";
import { asArray, asString, field, isRecord } from "./jsonValue.js";

// The community Free Dictionary API serves Wiktionary content (CC BY-SA): rich pronunciation
// (IPA + audio), example sentences, and etymology, plus senses grouped by part of speech.
export const wiktionarySource =
  "Definitions and pronunciation from Wiktionary via the Free Dictionary API (CC BY-SA).";

// A few senses per part of speech keep the popover scannable.
const maxSensesPerPartOfSpeech = 6;

// What the composer consumes from Wiktionary: the role-specific pieces it owns (pronunciation,
// etymology) plus its senses grouped by part of speech (the primary sense source).
export type WiktionaryResult = Readonly<{
  etymology?: string | undefined;
  partsOfSpeech: ReadonlyArray<DictionaryPartOfSpeech>;
  pronunciations: ReadonlyArray<DictionaryPronunciation>;
}>;

export interface WiktionaryProvider {
  lookup(term: string): Promise<WiktionaryResult | null>;
}

// Pronunciations from the `phonetics` array (each `{ text, audio }`), falling back to the
// top-level `phonetic` string; deduped by IPA, audio attached only when a non-empty URL.
function pronunciationsOf(entry: Record<string, unknown>): ReadonlyArray<DictionaryPronunciation> {
  const seen = new Set<string>();
  const pronunciations: DictionaryPronunciation[] = [];

  for (const phonetic of asArray(field(entry, "phonetics"))) {
    const ipa = asString(field(phonetic, "text"));

    if (ipa === undefined || seen.has(ipa)) {
      continue;
    }

    seen.add(ipa);
    const audio = asString(field(phonetic, "audio"));
    pronunciations.push(audio === undefined || audio.length === 0 ? { ipa } : { audio, ipa });
  }

  if (pronunciations.length === 0) {
    const phonetic = asString(field(entry, "phonetic"));

    if (phonetic !== undefined) {
      pronunciations.push({ ipa: phonetic });
    }
  }

  return pronunciations;
}

// A sense's synonyms: the definition's own synonyms unioned with its meaning's, cleaned of the
// headword and duplicates.
function synonymsOf(
  definition: unknown,
  meaningSynonyms: unknown,
  headword: string
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of [...asArray(field(definition, "synonyms")), ...asArray(meaningSynonyms)]) {
    const synonym = asString(raw)?.trim();

    if (synonym === undefined || synonym.length === 0) {
      continue;
    }

    const key = synonym.toLowerCase();

    if (key === headword.toLowerCase() || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(synonym);
  }

  return result;
}

function sensesOf(meaning: unknown, headword: string): ReadonlyArray<DictionarySense> {
  const meaningSynonyms = field(meaning, "synonyms");
  const senses: DictionarySense[] = [];

  for (const definition of asArray(field(meaning, "definitions"))) {
    const gloss = asString(field(definition, "definition"));

    if (gloss === undefined) {
      continue;
    }

    const example = asString(field(definition, "example"));
    senses.push({
      definition: gloss,
      examples: example === undefined ? [] : [example],
      synonyms: [...synonymsOf(definition, meaningSynonyms, headword)]
    });

    if (senses.length >= maxSensesPerPartOfSpeech) {
      break;
    }
  }

  return senses;
}

function partsOfSpeechOf(
  entry: Record<string, unknown>,
  headword: string
): ReadonlyArray<DictionaryPartOfSpeech> {
  const parts: DictionaryPartOfSpeech[] = [];

  for (const meaning of asArray(field(entry, "meanings"))) {
    const senses = sensesOf(meaning, headword);

    if (senses.length === 0) {
      continue;
    }

    const partOfSpeech = asString(field(meaning, "partOfSpeech"));
    parts.push(
      partOfSpeech === undefined ? { senses: [...senses] } : { partOfSpeech, senses: [...senses] }
    );
  }

  return parts;
}

// Pure adapter: normalizes the Free Dictionary array shape into a WiktionaryResult, or null
// when there is no usable entry (not an array, or no leading record with a `word`). A no-match
// response is an object, not an array, so it has no record at index 0.
export function adaptWiktionary(payload: unknown): WiktionaryResult | null {
  const entry = asArray(payload).find(isRecord);

  if (entry === undefined) {
    return null;
  }

  const headword = asString(field(entry, "word"));

  if (headword === undefined) {
    return null;
  }

  const etymology = asString(field(entry, "origin"));

  return {
    partsOfSpeech: partsOfSpeechOf(entry, headword),
    pronunciations: pronunciationsOf(entry),
    ...(etymology === undefined ? {} : { etymology })
  };
}

export type FreeDictionaryProviderDependencies = Readonly<{
  httpClient: HttpClient;
}>;

function buildUrl(term: string): string {
  return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`;
}

// The Wiktionary provider over the community Free Dictionary API (no key). Resolves to null on
// any transport/HTTP error or no-match so the composer falls back to WordNet.
export function createFreeDictionaryProvider(
  dependencies: FreeDictionaryProviderDependencies
): WiktionaryProvider {
  async function lookup(term: string): Promise<WiktionaryResult | null> {
    const result = await dependencies.httpClient.getJson<unknown>(buildUrl(term));

    if (!result.ok) {
      return null;
    }

    return adaptWiktionary(result.value);
  }

  return Object.freeze({ lookup });
}
