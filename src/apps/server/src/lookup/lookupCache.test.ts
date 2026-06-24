import { describe, expect, it } from "vitest";

import { createInMemoryLookupCache } from "./lookupCache.js";

describe("createInMemoryLookupCache", () => {
  it("returns undefined for a key that was never set", () => {
    const cache = createInMemoryLookupCache<string>();

    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a stored value before its TTL elapses (default clock)", () => {
    const cache = createInMemoryLookupCache<string>();
    cache.set("k", "v", 60000);

    expect(cache.get("k")).toBe("v");
  });

  it("treats an entry as a miss once its TTL has elapsed", () => {
    let clock = 1000;
    const cache = createInMemoryLookupCache<string>(() => clock);
    cache.set("k", "v", 500);

    clock = 1499;
    expect(cache.get("k")).toBe("v");

    clock = 1500;
    expect(cache.get("k")).toBeUndefined();
    // The expired entry is dropped, so a later read is still a miss.
    expect(cache.get("k")).toBeUndefined();
  });

  it("overwrites a value and its expiry on a repeated set", () => {
    let clock = 0;
    const cache = createInMemoryLookupCache<number>(() => clock);
    cache.set("k", 1, 100);
    cache.set("k", 2, 100);

    clock = 50;
    expect(cache.get("k")).toBe(2);
  });
});
