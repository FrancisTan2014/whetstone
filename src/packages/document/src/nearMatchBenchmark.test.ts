import { describe, expect, it } from "vitest";

import { projectNearMatch, type NearMatchProjection } from "./nearMatch.js";
import { selectNearMatches, type NearMatchPoolEntry } from "./nearMatchRanking.js";

// #713 scale benchmark. The owner-scoped query length-bands the pool before scoring, so a real ranking call
// touches a small slice; this benchmark deliberately skips that prefilter and scores the WHOLE 10,000-note
// pool on every query, a strict upper bound on production cost. It asserts only a generous p95 budget — never
// a fragile micro-time equality — so it guards against an accidental super-linear regression without turning
// ordinary machine variance into a flake.

// A very generous per-query budget (milliseconds) for scoring the entire unbanded 10,000-note pool. Real
// queries score orders of magnitude fewer rows after length-banding, so this is a loose ceiling that only
// fails on a gross algorithmic regression.
const P95_BUDGET_MS = 750;
const POOL_SIZE = 10_000;
const QUERY_COUNT = 40;

// Deterministically synthesize a distinct eligible sentence for index `n`, so the pool is reproducible and
// every entry projects to a real near-match projection (5 plain ASCII word tokens, well within the bounds).
function syntheticSentence(n: number): string {
  const adjectives = [
    "steady",
    "narrow",
    "distant",
    "golden",
    "quiet",
    "hidden",
    "sudden",
    "frozen"
  ];
  const nouns = [
    "harbor",
    "meadow",
    "thunder",
    "feather",
    "curtain",
    "bridge",
    "hallway",
    "mountain"
  ];
  const verbs = ["settles", "drifts", "returns", "widens", "steadies", "fades", "shifts", "holds"];
  const a = adjectives[n % adjectives.length];
  const b = nouns[Math.floor(n / adjectives.length) % nouns.length];
  const c = verbs[Math.floor(n / (adjectives.length * nouns.length)) % verbs.length];
  return `the ${a} ${b} ${c} number ${n}`;
}

function project(sentence: string): NearMatchProjection {
  const projection = projectNearMatch({
    content: [{ content: [{ text: sentence, type: "text" }], type: "paragraph" }],
    type: "doc"
  });
  // Every synthesized sentence is eligible by construction; assert to keep the benchmark honest.
  if (projection === null) {
    throw new Error(`benchmark sentence failed to project: ${sentence}`);
  }
  return projection;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

describe("near-match ranking scale benchmark", () => {
  it(`ranks a target against ${POOL_SIZE} notes within a generous p95 budget`, () => {
    const pool: NearMatchPoolEntry<{ id: string }>[] = Array.from(
      { length: POOL_SIZE },
      (_, index) => ({
        note: { id: `note-${index}` },
        projection: project(syntheticSentence(index))
      })
    );

    const durations: number[] = [];
    for (let query = 0; query < QUERY_COUNT; query += 1) {
      // Probe with a near-variant of an existing pool sentence so the hot path exercises real scoring, not an
      // early evidence veto.
      const target = project(syntheticSentence(query).replace("number", "numbir"));
      const start = performance.now();
      const matches = selectNearMatches(target, pool, (note) => note.id);
      durations.push(performance.now() - start);
      expect(matches.length).toBeLessThanOrEqual(5);
    }

    const p95 = percentile(durations, 0.95);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
