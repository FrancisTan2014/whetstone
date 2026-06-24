import type { LookupResponse } from "@whetstone/contracts";

import type { DictionaryProvider } from "./dictionaryProvider.types.js";
import type { LookupCache } from "./lookupCache.js";

// Cache lookups for ten minutes: long enough to spare a re-hit on a re-selected word,
// short enough to stay fresh.
export const lookupCacheTtlMs = 10 * 60 * 1000;

const notFound: LookupResponse = { found: false };

// One link in the provider chain: a provider plus the attribution to surface when it is
// the source that matched (Free Dictionary has none).
export type LookupSource = Readonly<{
  attribution?: string | undefined;
  provider: DictionaryProvider;
}>;

export type LookupServiceDependencies = Readonly<{
  cache: LookupCache<LookupResponse>;
  // Tried in order; the first non-null match wins. Built by the composition root so absent
  // keys simply omit their MW source, leaving the no-key Free Dictionary fallback.
  sources: ReadonlyArray<LookupSource>;
}>;

export type LookupService = Readonly<{
  lookup: (term: string, language: string) => Promise<LookupResponse>;
}>;

// Orchestrates the provider chain and caching: walk the ordered sources, returning the
// first match (with its attribution if any); cache the result — including not-found — by
// `language:term`.
export function createLookupService(dependencies: LookupServiceDependencies): LookupService {
  async function resolve(term: string, language: string): Promise<LookupResponse> {
    for (const source of dependencies.sources) {
      const entry = await source.provider.lookup(term, language);

      if (entry !== null) {
        return source.attribution === undefined
          ? { entry, found: true }
          : { attribution: source.attribution, entry, found: true };
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
