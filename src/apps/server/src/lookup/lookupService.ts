import type { DictionaryEntry, LookupResponse } from "@whetstone/contracts";

import type { LookupCache } from "./lookupCache.js";

// Cache lookups for ten minutes: long enough to spare a re-hit on a re-selected word,
// short enough to stay fresh.
export const lookupCacheTtlMs = 10 * 60 * 1000;

const notFound: LookupResponse = { found: false };

// One language-scoped source: a composed lookup for the languages it serves. English is the
// Wiktionary+WordNet composer; Chinese is CC-CEDICT. Each returns a fully composed
// DictionaryEntry (its own attribution lives in the entry's `sources`).
export type LookupSource = Readonly<{
  languages: ReadonlyArray<string>;
  lookup: (term: string) => Promise<DictionaryEntry | null>;
}>;

export type LookupServiceDependencies = Readonly<{
  cache: LookupCache<LookupResponse>;
  // Tried in order; the first source serving the language whose lookup matches wins.
  sources: ReadonlyArray<LookupSource>;
}>;

export type LookupService = Readonly<{
  lookup: (term: string, language: string) => Promise<LookupResponse>;
}>;

// Orchestrates the language-routed sources and caching: walk the ordered sources that serve the
// requested language, returning the first composed entry; cache the result — including
// not-found — by `language:term` so en and zh keys never collide.
export function createLookupService(dependencies: LookupServiceDependencies): LookupService {
  async function resolve(term: string, language: string): Promise<LookupResponse> {
    for (const source of dependencies.sources) {
      if (!source.languages.includes(language)) {
        continue;
      }

      const entry = await source.lookup(term);

      if (entry !== null) {
        return { entry, found: true };
      }
    }

    return notFound;
  }

  async function lookup(term: string, language: string): Promise<LookupResponse> {
    const key = `${language}:${term}`;
    const cached = dependencies.cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const response = await resolve(term, language);
    dependencies.cache.set(key, response, lookupCacheTtlMs);
    return response;
  }

  return Object.freeze({ lookup });
}
