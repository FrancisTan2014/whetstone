import type { DictionaryEntry, LookupResponse } from "@whetstone/contracts";
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

const englishEntry = entry("from English");
const chineseEntry = entry("from CC-CEDICT");

type CountingSource = LookupSource & { calls: () => number };

function source(languages: ReadonlyArray<string>, result: DictionaryEntry | null): CountingSource {
  const state = { calls: 0 };
  return {
    calls: () => state.calls,
    languages,
    lookup: () => {
      state.calls += 1;
      return Promise.resolve(result);
    }
  };
}

describe("createLookupService", () => {
  it("returns the first serving source's entry and skips later sources", async () => {
    const english = source(["en"], englishEntry);
    const later = source(["en"], entry("later"));
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [english, later]
    });

    expect(await service.lookup("word", "en")).toEqual({ entry: englishEntry, found: true });
    expect(later.calls()).toBe(0);
  });

  it("falls through a missing source to the next serving source", async () => {
    const missing = source(["en"], null);
    const english = source(["en"], englishEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [missing, english]
    });

    expect(await service.lookup("word", "en")).toEqual({ entry: englishEntry, found: true });
    expect(missing.calls()).toBe(1);
  });

  it("routes by language: a Chinese lookup skips the English source and hits the zh source", async () => {
    const english = source(["en"], englishEntry);
    const cedict = source(["zh-CN", "zh-TW"], chineseEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [english, cedict]
    });

    expect(await service.lookup("你好", "zh-CN")).toEqual({ entry: chineseEntry, found: true });
    expect(english.calls()).toBe(0);
    expect(cedict.calls()).toBe(1);
  });

  it("returns an explicit not-found when every serving source misses", async () => {
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [source(["en"], null)]
    });

    expect(await service.lookup("absent", "en")).toEqual({ found: false });
  });

  it("caches a result by language:term and serves repeats from the cache", async () => {
    const english = source(["en"], englishEntry);
    const setSpy = vi.fn();
    const inner = createInMemoryLookupCache<LookupResponse>();
    const cache: LookupCache<LookupResponse> = {
      get: inner.get,
      set: (key, value, ttlMs) => {
        setSpy(key, ttlMs);
        inner.set(key, value, ttlMs);
      }
    };
    const service = createLookupService({ cache, sources: [english] });

    await service.lookup("word", "en");
    const second = await service.lookup("word", "en");

    expect(second).toEqual({ entry: englishEntry, found: true });
    expect(english.calls()).toBe(1);
    expect(setSpy).toHaveBeenCalledWith("en:word", lookupCacheTtlMs);
  });
});
