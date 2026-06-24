import type { NormalizedEntry, NormalizedSense } from "@whetstone/contracts";

import type { DictionaryProvider } from "./dictionaryProvider.types.js";
import type { HttpClient } from "./httpClient.js";
import { asArray, asString, field, isRecord } from "./jsonValue.js";

// A few concise senses keep the popover scannable.
const maxSenses = 3;

function buildSense(
  gloss: string,
  partOfSpeech: string | undefined,
  example: string | undefined
): NormalizedSense {
  return {
    gloss,
    ...(partOfSpeech === undefined ? {} : { partOfSpeech }),
    ...(example === undefined ? {} : { example })
  };
}

function pronunciationOf(entry: Record<string, unknown>): string | undefined {
  const phonetic = asString(field(entry, "phonetic"));

  if (phonetic !== undefined) {
    return phonetic;
  }

  for (const phonetics of asArray(field(entry, "phonetics"))) {
    const text = asString(field(phonetics, "text"));

    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
}

function sensesOf(entry: Record<string, unknown>): ReadonlyArray<NormalizedSense> {
  const senses: NormalizedSense[] = [];

  for (const meaning of asArray(field(entry, "meanings"))) {
    const partOfSpeech = asString(field(meaning, "partOfSpeech"));

    for (const definition of asArray(field(meaning, "definitions"))) {
      const gloss = asString(field(definition, "definition"));

      if (gloss !== undefined) {
        senses.push(buildSense(gloss, partOfSpeech, asString(field(definition, "example"))));
      }
    }
  }

  return senses;
}

// Pure adapter: normalizes the Free Dictionary array shape into a capped NormalizedEntry,
// or null when there is no usable entry (not an array, no leading record, missing word, or
// no definitions). A no-match response is an object, not an array, so it has no record at
// index 0.
export function adaptFreeDictionary(payload: unknown): NormalizedEntry | null {
  const entry = asArray(payload).find(isRecord);

  if (entry === undefined) {
    return null;
  }

  const headword = asString(field(entry, "word"));

  if (headword === undefined) {
    return null;
  }

  const senses = sensesOf(entry);

  if (senses.length === 0) {
    return null;
  }

  const pronunciation = pronunciationOf(entry);

  return {
    headword,
    senses: senses.slice(0, maxSenses),
    ...(pronunciation === undefined ? {} : { pronunciation })
  };
}

export type FreeDictionaryProviderDependencies = Readonly<{
  httpClient: HttpClient;
}>;

function buildUrl(term: string): string {
  return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`;
}

// The fallback provider (no key). Resolves to null on any transport/HTTP error or no-match
// so the service returns an explicit not-found.
export function createFreeDictionaryProvider(
  dependencies: FreeDictionaryProviderDependencies
): DictionaryProvider {
  async function lookup(term: string): Promise<NormalizedEntry | null> {
    const result = await dependencies.httpClient.getJson<unknown>(buildUrl(term));

    if (!result.ok) {
      return null;
    }

    return adaptFreeDictionary(result.value);
  }

  return Object.freeze({ lookup });
}
