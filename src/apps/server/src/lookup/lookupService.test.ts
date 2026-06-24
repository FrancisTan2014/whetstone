import type { LookupResponse, NormalizedEntry } from "@whetstone/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DictionaryProvider } from "./dictionaryProvider.types.js";
import { createInMemoryLookupCache, type LookupCache } from "./lookupCache.js";
import { createLookupService, lookupCacheTtlMs, type LookupSource } from "./lookupService.js";

const learnersEntry: NormalizedEntry = { headword: "word", senses: [{ gloss: "from Learner's" }] };
const collegiateEntry: NormalizedEntry = {
  headword: "word",
  senses: [{ gloss: "from Collegiate" }]
};
const freeEntry: NormalizedEntry = { headword: "word", senses: [{ gloss: "from Free" }] };

const learnersAttribution = "Learner's attribution.";
const collegiateAttribution = "Collegiate attribution.";

type CountingProvider = DictionaryProvider & { calls: number };

function provider(entry: NormalizedEntry | null): CountingProvider {
  const state = { calls: 0 };
  return {
    get calls(): number {
      return state.calls;
    },
    lookup: () => {
      state.calls += 1;
      return Promise.resolve(entry);
    }
  };
}

// The three-link chain the composition root builds: Learner's, Collegiate, Free Dictionary —
// all serving English.
function chain(
  learners: CountingProvider,
  collegiate: CountingProvider,
  free: CountingProvider
): LookupSource[] {
  return [
    { attribution: learnersAttribution, languages: ["en"], provider: learners },
    { attribution: collegiateAttribution, languages: ["en"], provider: collegiate },
    { languages: ["en"], provider: free }
  ];
}

describe("createLookupService", () => {
  it("uses Learner's first and attaches its attribution, skipping later sources", async () => {
    const learners = provider(learnersEntry);
    const collegiate = provider(collegiateEntry);
    const free = provider(freeEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: chain(learners, collegiate, free)
    });

    expect(await service.lookup("word", "en")).toEqual({
      attribution: learnersAttribution,
      entry: learnersEntry,
      found: true
    });
    expect(collegiate.calls).toBe(0);
    expect(free.calls).toBe(0);
  });

  it("falls back to Collegiate when Learner's has no match", async () => {
    const learners = provider(null);
    const collegiate = provider(collegiateEntry);
    const free = provider(freeEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: chain(learners, collegiate, free)
    });

    expect(await service.lookup("word", "en")).toEqual({
      attribution: collegiateAttribution,
      entry: collegiateEntry,
      found: true
    });
    expect(learners.calls).toBe(1);
    expect(free.calls).toBe(0);
  });

  it("falls through both Merriam-Webster sources to Free Dictionary when they miss", async () => {
    const learners = provider(null);
    const collegiate = provider(null);
    const free = provider(freeEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: chain(learners, collegiate, free)
    });

    expect(await service.lookup("word", "en")).toEqual({ entry: freeEntry, found: true });
    expect(learners.calls).toBe(1);
    expect(collegiate.calls).toBe(1);
  });

  it("uses Free Dictionary alone when no Merriam-Webster keys are configured", async () => {
    const free = provider(freeEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [{ languages: ["en"], provider: free }]
    });

    expect(await service.lookup("word", "en")).toEqual({ entry: freeEntry, found: true });
  });

  it("returns an explicit not-found when every source misses", async () => {
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: chain(provider(null), provider(null), provider(null))
    });

    expect(await service.lookup("absent", "en")).toEqual({ found: false });
  });

  it("routes by language: a Chinese lookup skips the English sources and hits the zh source", async () => {
    const learners = provider(learnersEntry);
    const collegiate = provider(collegiateEntry);
    const free = provider(freeEntry);
    const cedict = provider(freeEntry);
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [
        ...chain(learners, collegiate, free),
        { attribution: "CC-CEDICT.", languages: ["zh-CN", "zh-TW"], provider: cedict }
      ]
    });

    expect(await service.lookup("你好", "zh-CN")).toEqual({
      attribution: "CC-CEDICT.",
      entry: freeEntry,
      found: true
    });
    expect(learners.calls).toBe(0);
    expect(collegiate.calls).toBe(0);
    expect(free.calls).toBe(0);
    expect(cedict.calls).toBe(1);
  });

  it("caches a result by language:term and serves repeats from the cache", async () => {
    const free = provider(freeEntry);
    const setSpy = vi.fn();
    const inner = createInMemoryLookupCache<LookupResponse>();
    const cache: LookupCache<LookupResponse> = {
      get: inner.get,
      set: (key, value, ttlMs) => {
        setSpy(key, ttlMs);
        inner.set(key, value, ttlMs);
      }
    };
    const service = createLookupService({
      cache,
      sources: [{ languages: ["en"], provider: free }]
    });

    await service.lookup("word", "en");
    const second = await service.lookup("word", "en");

    expect(second).toEqual({ entry: freeEntry, found: true });
    expect(free.calls).toBe(1);
    expect(setSpy).toHaveBeenCalledWith("en:word", lookupCacheTtlMs);
  });
});
