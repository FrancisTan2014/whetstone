import type { DictionaryEntry, LookupResponse, LookupSourceId } from "@whetstone/contracts";

import type { LookupCache } from "./lookupCache.js";

// Cache lookups for ten minutes: long enough to spare a re-hit on a re-selected word,
// short enough to stay fresh.
export const lookupCacheTtlMs = 10 * 60 * 1000;

const notFound: LookupResponse = { found: false };

// One named lookup source the reader can show as its own tab (WordNet, Wiktionary, CC-CEDICT). Each
// fetches independently, so one source being slow/down/empty fails to its own tab — never the popover.
export type LookupSource = Readonly<{
  id: LookupSourceId;
  languages: ReadonlyArray<string>;
  lookup: (term: string) => Promise<DictionaryEntry | null>;
}>;

export type LookupServiceDependencies = Readonly<{
  cache: LookupCache<LookupResponse>;
  sources: ReadonlyArray<LookupSource>;
}>;

export type LookupService = Readonly<{
  lookup: (term: string, language: string, source: LookupSourceId) => Promise<LookupResponse>;
}>;

// Resolve a single requested source: the source whose id and language match. A missing source or
// an empty result is not-found, cached by `language:source:term` so tabs and languages never collide.
export function createLookupService(dependencies: LookupServiceDependencies): LookupService {
  async function resolve(
    term: string,
    language: string,
    source: LookupSourceId
  ): Promise<LookupResponse> {
    const matched = dependencies.sources.find(
      (candidate) => candidate.id === source && candidate.languages.includes(language)
    );

    if (matched === undefined) {
      return notFound;
    }

    const entry = await matched.lookup(term);
    return entry === null ? notFound : { entry, found: true };
  }

  async function lookup(
    term: string,
    language: string,
    source: LookupSourceId
  ): Promise<LookupResponse> {
    const key = `${language}:${source}:${term}`;
    const cached = dependencies.cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const response = await resolve(term, language, source);
    dependencies.cache.set(key, response, lookupCacheTtlMs);
    return response;
  }

  return Object.freeze({ lookup });
}
