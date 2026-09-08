import { describe, expect, it, vi } from "vitest";

import {
  buildExplainCacheKey,
  createExplainInFlightCoalescer,
  createInMemoryExplainCache,
  fingerprintExplainContext
} from "./explainCache.js";

function keyInput(overrides: Partial<Parameters<typeof buildExplainCacheKey>[0]> = {}) {
  return {
    blockEntryId: "block-1",
    contentRevision: 1,
    contextFingerprint: fingerprintExplainContext("the resolved bounded context"),
    endOffset: 10,
    headword: "hello",
    language: "en",
    model: "gpt-5.4",
    promptVersion: "semantic-map-v1",
    reasoningEffort: "high",
    startOffset: 5,
    workEntryId: "work-1",
    ...overrides
  };
}

describe("fingerprintExplainContext", () => {
  it("produces the same fingerprint for identical context text", () => {
    expect(fingerprintExplainContext("same context")).toBe(
      fingerprintExplainContext("same context")
    );
  });

  it("produces a different fingerprint for different context text", () => {
    expect(fingerprintExplainContext("context A")).not.toBe(fingerprintExplainContext("context B"));
  });

  it("is bounded in size regardless of how long the input context is", () => {
    const fingerprint = fingerprintExplainContext("x".repeat(50_000));
    expect(fingerprint.length).toBeLessThan(100);
  });
});

describe("buildExplainCacheKey", () => {
  it("produces the same key for identical input", () => {
    expect(buildExplainCacheKey(keyInput())).toBe(buildExplainCacheKey(keyInput()));
  });

  it("returns a JSON array (tuple), not a delimiter-joined string", () => {
    const key = buildExplainCacheKey(keyInput());
    expect(() => JSON.parse(key)).not.toThrow();
    expect(Array.isArray(JSON.parse(key))).toBe(true);
  });

  it.each([
    ["workEntryId", "work-2"],
    ["blockEntryId", "block-2"],
    ["startOffset", 6],
    ["endOffset", 11],
    ["headword", "goodbye"],
    ["language", "zh"],
    ["contentRevision", 2],
    ["contextFingerprint", fingerprintExplainContext("a genuinely different resolved context")],
    ["promptVersion", "semantic-map-v2"],
    ["model", "gpt-5.5"],
    ["reasoningEffort", "low"]
  ] as const)("changes the key when %s differs", (field, value) => {
    expect(buildExplainCacheKey(keyInput({ [field]: value }))).not.toBe(
      buildExplainCacheKey(keyInput())
    );
  });

  it("misses the cache when only the resolved context changes — term/range/revision held constant", () => {
    // The regression the fingerprint field exists to close: `contentRevision` and the block's own
    // plaintext are read via two separate concurrent queries (`explainSourceResolution.ts`), so a real
    // context change is not guaranteed to be reflected in `contentRevision` alone.
    const before = buildExplainCacheKey(
      keyInput({ contextFingerprint: fingerprintExplainContext("old surrounding sentence") })
    );
    const after = buildExplainCacheKey(
      keyInput({ contextFingerprint: fingerprintExplainContext("new surrounding sentence") })
    );
    expect(before).not.toBe(after);
  });

  it("never collides across field boundaries even with an embedded NUL that WOULD have collided under a delimiter-joined string", () => {
    // Under the old `\u0000`-joined scheme, `headword="a\u0000b", language="c"` and
    // `headword="a", language="b\u0000c"` would produce the IDENTICAL joined string
    // ("a\u0000b\u0000c" both ways) — exactly the unproven-assumption collision this fix removes. The
    // JSON-tuple key keeps each field's own quoting/escaping, so these two genuinely different inputs
    // must produce two different keys.
    const first = buildExplainCacheKey(keyInput({ headword: "a\u0000b", language: "c" }));
    const second = buildExplainCacheKey(keyInput({ headword: "a", language: "b\u0000c" }));
    expect(first).not.toBe(second);
  });
});

describe("createInMemoryExplainCache", () => {
  it("returns undefined for a miss and the stored value for a hit", () => {
    const cache = createInMemoryExplainCache<number>();
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("expires an entry once its TTL has elapsed", () => {
    let now = 0;
    const cache = createInMemoryExplainCache<number>({ now: () => now, ttlMs: 100 });
    cache.set("a", 1);
    now = 99;
    expect(cache.get("a")).toBe(1);
    now = 100;
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the oldest entry once at capacity", () => {
    const cache = createInMemoryExplainCache<number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("re-setting an existing key moves it back to the newest position", () => {
    const cache = createInMemoryExplainCache<number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);

    // "b" is now the oldest untouched entry, so it is the one evicted, not "a".
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(10);
    expect(cache.get("c")).toBe(3);
  });

  it("exposes only get/set — no way to reach the backing store", () => {
    const cache = createInMemoryExplainCache<number>();
    expect(Object.isFrozen(cache)).toBe(true);
    expect(Object.keys(cache).sort()).toEqual(["get", "set"]);
  });

  it("tolerates a degenerate zero maxEntries configuration without throwing", () => {
    // With maxEntries 0 the map is always empty when the capacity check fires, so there is no oldest
    // key to evict — this is the defensive "nothing to evict yet" branch, distinct from the normal
    // eviction path already covered above.
    const cache = createInMemoryExplainCache<number>({ maxEntries: 0 });
    expect(() => cache.set("a", 1)).not.toThrow();
  });

  it("isolates the cache from a caller mutating the object AFTER calling set() — a later get() is unaffected", () => {
    const cache = createInMemoryExplainCache<{ families: string[] }>();
    const input = { families: ["family-1"] };
    cache.set("a", input);

    input.families.push("family-2");

    expect(cache.get("a")).toEqual({ families: ["family-1"] });
  });

  it("isolates the cache from a caller mutating a returned get() value — a later get() still returns the original", () => {
    const cache = createInMemoryExplainCache<{ families: string[] }>();
    cache.set("a", { families: ["family-1"] });

    const first = cache.get("a");
    first?.families.push("poisoned");

    expect(cache.get("a")).toEqual({ families: ["family-1"] });
  });

  it("returns a fresh clone (not the same reference) from set()'s stored input and from get()", () => {
    const cache = createInMemoryExplainCache<{ families: string[] }>();
    const input = { families: ["family-1"] };
    cache.set("a", input);

    const stored = cache.get("a");
    expect(stored).toEqual(input);
    expect(stored).not.toBe(input);
  });
});

describe("createExplainInFlightCoalescer", () => {
  it("runs the start function once for a single caller", async () => {
    const coalescer = createExplainInFlightCoalescer<string>();
    const start = vi.fn().mockResolvedValue("done");
    await expect(coalescer.run("k", start)).resolves.toBe("done");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls for the same key into one in-flight promise", async () => {
    const coalescer = createExplainInFlightCoalescer<string>();
    let resolveStart: (value: string) => void = () => {};
    const start = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStart = resolve;
        })
    );

    const first = coalescer.run("k", start);
    const second = coalescer.run("k", start);
    expect(start).toHaveBeenCalledTimes(1);

    resolveStart("shared");
    await expect(first).resolves.toBe("shared");
    await expect(second).resolves.toBe("shared");
  });

  it("does not coalesce calls for different keys", async () => {
    const coalescer = createExplainInFlightCoalescer<string>();
    const start = vi.fn().mockResolvedValue("done");
    await Promise.all([coalescer.run("a", start), coalescer.run("b", start)]);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("clears the key on success so the next call gets a fresh attempt", async () => {
    const coalescer = createExplainInFlightCoalescer<string>();
    const start = vi.fn().mockResolvedValue("first").mockResolvedValueOnce("first");
    await coalescer.run("k", start);

    const secondStart = vi.fn().mockResolvedValue("second");
    await expect(coalescer.run("k", secondStart)).resolves.toBe("second");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  it("clears the key on failure too — no permanently stuck key, and no automatic retry", async () => {
    const coalescer = createExplainInFlightCoalescer<string>();
    const failingStart = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(coalescer.run("k", failingStart)).rejects.toThrow("boom");

    const nextStart = vi.fn().mockResolvedValue("recovered");
    await expect(coalescer.run("k", nextStart)).resolves.toBe("recovered");
    expect(nextStart).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight failure across concurrent callers rather than each retrying independently", async () => {
    const coalescer = createExplainInFlightCoalescer<string>();
    let rejectStart: (error: Error) => void = () => {};
    const start = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectStart = reject;
        })
    );

    const first = coalescer.run("k", start);
    const second = coalescer.run("k", start);
    expect(start).toHaveBeenCalledTimes(1);

    rejectStart(new Error("shared failure"));
    await expect(first).rejects.toThrow("shared failure");
    await expect(second).rejects.toThrow("shared failure");
  });

  it("keeps a reentrant newer registration intact when an inner call for the same key settles first", async () => {
    // A pathological same-tick key reuse: `outerStart` itself calls `run()` again for the SAME key
    // before the outer call has registered its own promise. The inner call settles (and its cleanup
    // runs) while the outer promise is still the current registration — the cleanup guard must notice
    // it no longer owns the registration and must NOT clear the outer one out from under it.
    const coalescer = createExplainInFlightCoalescer<string>();
    let resolveOuter: (value: string) => void = () => {};
    let innerPromise: Promise<string> | undefined;

    const outer = coalescer.run("k", () => {
      innerPromise = coalescer.run("k", () => Promise.resolve("inner"));
      return new Promise<string>((resolve) => {
        resolveOuter = resolve;
      });
    });

    await innerPromise;
    await Promise.resolve();
    await Promise.resolve();

    const afterInner = vi.fn().mockResolvedValue("after");
    expect(coalescer.run("k", afterInner)).toBe(outer);
    expect(afterInner).not.toHaveBeenCalled();

    resolveOuter("outer-done");
    await expect(outer).resolves.toBe("outer-done");
  });
});
