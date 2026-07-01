import type { DictionaryEntry, LookupResponse, LookupSourceId } from "@whetstone/contracts";

import type { LookupCache } from "./lookupCache.js";

// Cache lookups for ten minutes: long enough to spare a re-hit on a re-selected word,
// short enough to stay fresh.
export const lookupCacheTtlMs = 10 * 60 * 1000;

const notFound: LookupResponse = { found: false };

// One named lookup source the reader can show as its own tab (WordNet, Wiktionary, CC-CEDICT, and the
// optional local-LLM "AI 解释"). Each fetches independently, so one source being slow/down/empty fails
// to its own tab — never the popover. `options` carries the request language and the selection's
// containing block text (`context`) for the LLM source (#341); dictionary sources ignore it.
export type LookupOptions = Readonly<{ context: string | undefined; language: string }>;

export type LookupSource = Readonly<{
  id: LookupSourceId;
  languages: ReadonlyArray<string>;
  lookup: (term: string, options: LookupOptions) => Promise<DictionaryEntry | null>;
}>;

export type LookupServiceDependencies = Readonly<{
  cache: LookupCache<LookupResponse>;
  sources: ReadonlyArray<LookupSource>;
}>;

export type LookupService = Readonly<{
  lookup: (
    term: string,
    language: string,
    source: LookupSourceId,
    context?: string
  ) => Promise<LookupResponse>;
}>;

// Resolve a single requested source: the source whose id and language match. A missing source or
// an empty result is not-found, cached by `language:source:term:context` so tabs, languages, and
// distinct contexts (the LLM aid glosses the same term differently per sentence) never collide.
export function createLookupService(dependencies: LookupServiceDependencies): LookupService {
  async function resolve(
    term: string,
    language: string,
    source: LookupSourceId,
    context: string | undefined
  ): Promise<LookupResponse> {
    const matched = dependencies.sources.find(
      (candidate) => candidate.id === source && candidate.languages.includes(language)
    );

    if (matched === undefined) {
      return notFound;
    }

    const entry = await matched.lookup(term, { context, language });
    return entry === null ? notFound : { entry, found: true };
  }

  async function lookup(
    term: string,
    language: string,
    source: LookupSourceId,
    context?: string
  ): Promise<LookupResponse> {
    const key = `${language}:${source}:${term}:${context ?? ""}`;
    const cached = dependencies.cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const response = await resolve(term, language, source, context);
    dependencies.cache.set(key, response, lookupCacheTtlMs);
    return response;
  }

  return Object.freeze({ lookup });
}
