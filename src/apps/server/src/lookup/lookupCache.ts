// A keyed, TTL-based cache for external lookup results so repeated terms do not re-hit a
// provider. The boundary is storage-agnostic (another store can implement it later); a
// simple in-memory implementation is provided. The clock is injected so expiry is tested
// deterministically without real timers.

export type LookupCache<T> = Readonly<{
  // Returns the cached value, or undefined on a miss or once the entry's TTL has elapsed.
  get: (key: string) => T | undefined;
  set: (key: string, value: T, ttlMs: number) => void;
}>;

type CacheEntry<T> = Readonly<{ expiresAt: number; value: T }>;

export function createInMemoryLookupCache<T>(now: () => number = () => Date.now()): LookupCache<T> {
  const entries = new Map<string, CacheEntry<T>>();

  function get(key: string): T | undefined {
    const entry = entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (now() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  function set(key: string, value: T, ttlMs: number): void {
    entries.set(key, { expiresAt: now() + ttlMs, value });
  }

  return Object.freeze({ get, set });
}
