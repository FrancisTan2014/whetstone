import { createHash } from "node:crypto";

// A bounded, successful-answer-only cache for the semantic-map explanation capability (#924), plus an
// in-flight coalescer so several concurrent, identical requests never trigger duplicate paid Copilot
// turns. Two distinct pieces because they enforce two distinct rules: the cache only ever stores an
// `ok` result (a caller must never call `set` with anything else — enforced by only ever being wired to
// the success path in `explainCommands.ts`, never by a status check in here), while the coalescer runs
// exactly once per key regardless of outcome, so concurrent callers share one failure too rather than
// each independently retrying while the first attempt is still in flight.

export type ExplainCacheKeyInput = Readonly<{
  blockEntryId: string;
  contentRevision: number;
  // A SHA-256 fingerprint (`fingerprintExplainContext`) of the actual resolved, bounded context string
  // — NOT merely `contentRevision`. `contentRevision` and the block's plaintext are read via two
  // separate concurrent queries (`explainSourceResolution.ts`), so a concurrent edit can pair an old
  // block snapshot with a newer revision (or vice versa); a cache key built only from `contentRevision`
  // could then treat two genuinely different resolved contexts as the same key, or miss a real context
  // change entirely. Folding in the context itself closes that gap: identical selection/term/range but a
  // changed context can never hit a stale cache entry.
  contextFingerprint: string;
  endOffset: number;
  headword: string;
  language: string;
  model: string;
  promptVersion: string;
  reasoningEffort: string;
  startOffset: number;
  workEntryId: string;
}>;

// A bounded-size fingerprint of the actual resolved context string, suitable for folding into the cache
// key without unboundedly growing it (context can be arbitrarily long text). Mirrors the existing
// `noteMaterialFingerprint.ts` convention (SHA-256 over UTF-8 bytes) rather than inventing a new hashing
// approach.
export function fingerprintExplainContext(context: string): string {
  return createHash("sha256").update(context, "utf8").digest("hex");
}

// One JSON-array ("tuple") key folding every field the acceptance criteria name: selection/term,
// language, canonical context (via its fingerprint), prompt version, and the requested model/effort —
// so a changed context, a bumped prompt, or an operator-changed model/effort can never reuse a stale
// cached answer. `JSON.stringify` correctly escapes every field regardless of content (including an
// actual embedded NUL character), rather than relying on an unproven assumption that a `\u0000`-joined
// string could never collide across field boundaries.
export function buildExplainCacheKey(input: ExplainCacheKeyInput): string {
  return JSON.stringify([
    input.workEntryId,
    input.blockEntryId,
    input.startOffset,
    input.endOffset,
    input.headword,
    input.language,
    input.contentRevision,
    input.contextFingerprint,
    input.promptVersion,
    input.model,
    input.reasoningEffort
  ]);
}

export type ExplainCache<T> = Readonly<{
  get: (key: string) => T | undefined;
  set: (key: string, value: T) => void;
}>;

type CacheEntry<T> = Readonly<{ expiresAt: number; value: T }>;

export type ExplainCacheOptions = Readonly<{
  maxEntries?: number;
  now?: () => number;
  ttlMs?: number;
}>;

const defaultExplainCacheMaxEntries = 200;
const defaultExplainCacheTtlMs = 10 * 60 * 1000;

// A TTL + bounded-size in-memory cache. Bounded by eviction, not merely TTL: once at capacity, the
// oldest entry (`Map` preserves insertion order; a re-set moves a key back to the newest position) is
// evicted before the new one is added, so a burst of many distinct selections can never grow this cache
// without limit. Frozen with only `get`/`set` exposed — no consumer can reach the backing `Map`.
//
// Both `get` and `set` pass values through `structuredClone`, isolating the cache's stored value from
// both the caller's own object (a `set` input mutated afterward by its caller must never affect what a
// later `get` returns) and from any object a caller mutates AFTER a `get` (that must never poison what
// the cache still holds, or what a later `get` for the same key returns). `T` here is always a JSON-
// shaped DTO (`ExplainCachedAnswer`), so the native platform `structuredClone` is sufficient — no
// hand-rolled deep-clone is needed.
export function createInMemoryExplainCache<T>(options: ExplainCacheOptions = {}): ExplainCache<T> {
  const maxEntries = options.maxEntries ?? defaultExplainCacheMaxEntries;
  const ttlMs = options.ttlMs ?? defaultExplainCacheTtlMs;
  const now = options.now ?? (() => Date.now());
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
    return structuredClone(entry.value);
  }

  function set(key: string, value: T): void {
    entries.delete(key);
    if (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) {
        entries.delete(oldestKey);
      }
    }
    entries.set(key, { expiresAt: now() + ttlMs, value: structuredClone(value) });
  }

  return Object.freeze({ get, set });
}

export type ExplainInFlightCoalescer<T> = Readonly<{
  // Runs `start()` for `key` unless a call for the SAME key is already in flight, in which case every
  // caller awaits that one shared promise. Cleared on settle (success OR failure) so the NEXT call after
  // it settles always gets a fresh attempt — never an automatic retry of a failure, and never a
  // permanently stuck key.
  run: (key: string, start: () => Promise<T>) => Promise<T>;
}>;

export function createExplainInFlightCoalescer<T>(): ExplainInFlightCoalescer<T> {
  const pending = new Map<string, Promise<T>>();

  function run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const promise = start().finally(() => {
      // Only clear THIS key's own entry, and only if it is still the one this call registered — a
      // pathological same-tick key reuse after settle could otherwise clear a newer registration.
      if (pending.get(key) === promise) {
        pending.delete(key);
      }
    });
    pending.set(key, promise);
    return promise;
  }

  return Object.freeze({ run });
}
