import type { DictionaryEntry, LookupResponse, LookupSourceId } from "@whetstone/contracts";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryLookupCache, type LookupCache } from "./lookupCache.js";
import { createLookupService, lookupCacheTtlMs, type LookupSource } from "./lookupService.js";

function entry(definition: string): DictionaryEntry {
  return {
    headword: "word",
    partsOfSpeech: [{ senses: [{ definition, examples: [], synonyms: [] }] }],
    pronunciations: [],
    sources: ["a source"]
  };
}

const wordnetEntry = entry("from WordNet");
const cedictEntry = entry("from CC-CEDICT");

type CountingSource = LookupSource & { calls: () => number };

function source(
  id: LookupSourceId,
  languages: ReadonlyArray<string>,
  result: DictionaryEntry | null
): CountingSource {
  const state = { calls: 0 };
  return {
    calls: () => state.calls,
    id,
    languages,
    lookup: () => {
      state.calls += 1;
      return Promise.resolve(result);
    }
  };
}

describe("createLookupService", () => {
  it("resolves only the requested source for the language", async () => {
    const wordnet = source("wordnet", ["en"], wordnetEntry);
    const wiktionary = source("wiktionary", ["en"], entry("from Wiktionary"));
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [wordnet, wiktionary]
    });

    expect(await service.lookup("word", "en", "wordnet")).toEqual({
      entry: wordnetEntry,
      found: true
    });
    expect(wiktionary.calls()).toBe(0);
  });

  it("routes by language: the cedict source serves zh, not en", async () => {
    const cedict = source("cedict", ["zh-CN", "zh-TW"], cedictEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [cedict]
    });

    expect(await service.lookup("你好", "zh-CN", "cedict")).toEqual({
      entry: cedictEntry,
      found: true
    });
  });

  it("returns not-found when the requested source misses or no source matches", async () => {
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [source("wordnet", ["en"], null)]
    });

    expect(await service.lookup("absent", "en", "wordnet")).toEqual({ found: false });
    expect(await service.lookup("word", "en", "wiktionary")).toEqual({ found: false });
  });

  it("caches by language:source:term and serves repeats from the cache", async () => {
    const wordnet = source("wordnet", ["en"], wordnetEntry);
    const setSpy = vi.fn();
    const inner = createInMemoryLookupCache<LookupResponse>();
    const cache: LookupCache<LookupResponse> = {
      get: inner.get,
      set: (key, value, ttlMs) => {
        setSpy(key, ttlMs);
        inner.set(key, value, ttlMs);
      }
    };
    const service = createLookupService({ cache, sources: [wordnet] });

    await service.lookup("word", "en", "wordnet");
    const second = await service.lookup("word", "en", "wordnet");

    expect(second).toEqual({ entry: wordnetEntry, found: true });
    expect(wordnet.calls()).toBe(1);
    expect(setSpy).toHaveBeenCalledWith("en:wordnet:word", lookupCacheTtlMs);
  });
});
