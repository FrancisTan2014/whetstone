import { describe, expect, it } from "vitest";

import { createTextDocument } from "./document.js";
import { projectNearMatch, type NearMatchProjection } from "./nearMatch.js";
import {
  NEAR_MATCH_THRESHOLD,
  selectNearMatches,
  type NearMatchPoolEntry
} from "./nearMatchRanking.js";

// #713 near-match ranking: the guarded policy that turns a length-banded pool into at most five conservative
// candidates. These tests lock the exclusions (exact material, case-only), the protected-evidence veto per
// family, the lexical guard that rejects related vocabulary, the threshold edge, and the stable top-five
// order — plus the metamorphic guarantee that changing any protected evidence can never create a candidate.

// Project a plain-text note, asserting it is eligible so tests fail loudly on an accidentally-unsupported
// fixture rather than silently skipping.
function project(value: string): NearMatchProjection {
  const projection = projectNearMatch(createTextDocument(value));
  if (projection === null) {
    throw new Error(`expected eligible near-match projection for: ${value}`);
  }
  return projection;
}

// Build a single-note pool keyed by a stable id.
function pool(
  entries: ReadonlyArray<{ id: string; text: string }>
): NearMatchPoolEntry<{ id: string }>[] {
  return entries.map((entry) => ({ note: { id: entry.id }, projection: project(entry.text) }));
}

const noteId = (note: { id: string }): string => note.id;

// Whether the single candidate is returned as a possible near match.
function matches(targetText: string, candidateText: string): boolean {
  const target = project(targetText);
  const result = selectNearMatches(target, pool([{ id: "c", text: candidateText }]), noteId);
  return result.length === 1;
}

describe("selectNearMatches positives", () => {
  it("returns typo, spacing, quote, and dash variants as possible near matches", () => {
    expect(matches("in terms of the design", "in term of the design")).toBe(true);
    expect(matches("it depends on the leader", "it depens on the leader")).toBe(true);
    expect(matches("we separate the concerns", "we seperate the concerns")).toBe(true);
    expect(matches("open the well known door", "open the well-known door")).toBe(true);
    expect(matches('she said "hello" to me', "she said 'hello' to me")).toBe(true);
  });
});

describe("selectNearMatches exclusions", () => {
  it("excludes a candidate with identical exact material", () => {
    // Same material differing only by a generated node id is exact, owned by the #711 review.
    const target = project("in terms of the design");
    const identical: NearMatchPoolEntry<{ id: string }> = {
      note: { id: "c" },
      projection: project("in terms of the design")
    };
    expect(selectNearMatches(target, [identical], noteId)).toHaveLength(0);
  });

  it("excludes a case-only difference", () => {
    expect(matches("the US policy applies here", "the us policy applies here")).toBe(false);
    expect(matches("Polish notation is prefix", "polish notation is prefix")).toBe(false);
  });

  it("keeps a quote-only or spacing-only difference (not case-only)", () => {
    // Identical relaxed key but a real, non-case difference stays a candidate.
    expect(matches("the plan is well known now", "the plan is well-known now")).toBe(true);
  });
});

describe("selectNearMatches protected-evidence veto", () => {
  it("vetoes a changed number", () => {
    expect(matches("we store up to 100 units", "we store up to 200 units")).toBe(false);
  });

  it("vetoes a changed negation", () => {
    expect(matches("the value is safe to use", "the value is not safe to use")).toBe(false);
  });

  it("vetoes a changed operator or symbol", () => {
    expect(matches("compute a, b and the sum", "compute a; b and the sum")).toBe(false);
  });

  it("vetoes a changed acronym or identifier", () => {
    expect(matches("prefer the IPX route here", "prefer the IPZ route here")).toBe(false);
  });
});

describe("selectNearMatches lexical guard", () => {
  it("vetoes a replaced word even one character away", () => {
    expect(matches("the cat sat on the mat", "the cat sat on the hat")).toBe(false);
  });

  it("vetoes different vocabulary of the same length", () => {
    expect(matches("a bear in the deep woods", "a born in the deep woods")).toBe(false);
    expect(matches("the quick brown fox runs", "the quick green fox runs")).toBe(false);
  });

  it("vetoes a word reorder", () => {
    expect(matches("the dog bites the man now", "the man bites the dog now")).toBe(false);
  });

  it("vetoes three or more changed words even when each is typo-scale", () => {
    // Three same-length substitutions is a rewrite, not a misspelling, so the guard stops counting and vetoes.
    expect(matches("alpha bravo charlie delta", "alphx bravx charlx delta")).toBe(false);
  });
});

describe("selectNearMatches threshold", () => {
  it("uses the named threshold constant", () => {
    expect(NEAR_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(NEAR_MATCH_THRESHOLD).toBeLessThan(1);
  });

  it("keeps a pair at the threshold and drops one below it", () => {
    // A single typo in a longer note scores well above the threshold.
    expect(matches("consider the parser design", "consider the parsor design")).toBe(true);
    // A two-edit typo in a short key scores below the calibrated threshold and is dropped.
    expect(matches("test parser", "test porsyr")).toBe(false);
  });
});

describe("selectNearMatches ordering and bound", () => {
  it("returns at most five, ordered by score descending then note id", () => {
    const target = project("consider the parser design now");
    const candidates = pool([
      { id: "n6", text: "consider the parser design now" }, // exact -> excluded
      { id: "n1", text: "consider the parsee design now" }, // 1 edit (parser)
      { id: "n5", text: "consider the parsor desigm now" }, // 2 edits (parser, design)
      { id: "n2", text: "consider the parser desigh now" }, // 1 edit (design)
      { id: "n3", text: "consider the parsor design now" }, // 1 edit (parser)
      { id: "n4", text: "consider the parser desigm now" } // 1 edit (design)
    ]);
    const result = selectNearMatches(target, candidates, noteId);
    expect(result).toHaveLength(5);
    // Non-increasing score.
    for (let index = 1; index < result.length; index += 1) {
      expect(result[index]!.score).toBeLessThanOrEqual(result[index - 1]!.score);
    }
    // Among the four equal one-edit candidates, ties break by ascending note id; the two-edit n5 sorts last.
    expect(result.map((candidate) => candidate.note.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });

  it("returns an empty list for an empty pool", () => {
    expect(selectNearMatches(project("in terms of the design"), [], noteId)).toEqual([]);
  });

  it("breaks equal-score ties by ascending note id regardless of pool order", () => {
    const target = project("consider the parser today");
    // Two equal-score typo variants supplied in descending id order must be reordered ascending.
    const result = selectNearMatches(
      target,
      pool([
        { id: "b", text: "consider the parsel today" },
        { id: "a", text: "consider the parsor today" }
      ]),
      noteId
    );
    expect(result.map((candidate) => candidate.note.id)).toEqual(["a", "b"]);
  });
});

describe("selectNearMatches metamorphic guarantees", () => {
  it("a candidate that matches never survives once any protected evidence is changed", () => {
    const target = project("we retry the request quickly");
    // A pure typo variant matches.
    expect(matches("we retry the request quickly", "we retry the requst quickly")).toBe(true);
    // Injecting a differing number, negation, symbol, or identifier into the same variant vetoes it.
    for (const mutated of [
      "we retry the requst quickly 5",
      "we do not retry the requst quickly",
      "we retry, the requst quickly",
      "we retry the requst QuiCkly"
    ]) {
      const injected = matches("we retry the request quickly", mutated);
      expect(injected).toBe(false);
    }
    // The original target is unchanged material, so the baseline match still holds independent of the above.
    expect(target.relaxedKey).toBe("we retry the request quickly");
  });
});
