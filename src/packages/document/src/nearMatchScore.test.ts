import levenshtein from "damerau-levenshtein";
import { describe, expect, it } from "vitest";

import {
  codePointLength,
  damerauLevenshteinCodePoints,
  nearMatchLengthBand,
  nearMatchScore
} from "./nearMatchScore.js";

// #713 scorer: the guarded near-Note scorer is the single, characterization-locked source of edit distance
// and similarity. These tests pin the pinned `damerau-levenshtein@1.0.8` package's behaviour (so an upgrade
// that changed distance, transposition, or empty handling fails here), prove the adapter measures CODE POINTS
// (not UTF-16 units) for astral input, and lock the score, its bounds and symmetry, and the completeness of
// the length prefilter band.

describe("pinned damerau-levenshtein package behaviour", () => {
  it("locks the package distance, transposition, and empty results the adapter depends on", () => {
    // A single substitution is one step.
    expect(levenshtein("abc", "abd").steps).toBe(1);
    // An adjacent transposition is a SINGLE step (the Damerau extension over plain Levenshtein).
    expect(levenshtein("ab", "ba").steps).toBe(1);
    expect(levenshtein("depends", "depneds").steps).toBe(1);
    // Insertion and deletion each cost one.
    expect(levenshtein("terms", "term").steps).toBe(1);
    // Two empty strings are identical; an empty against a non-empty costs the non-empty length.
    expect(levenshtein("", "").steps).toBe(0);
    expect(levenshtein("", "abc").steps).toBe(3);
    expect(levenshtein("abc", "").steps).toBe(3);
  });
});

describe("codePointLength", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(codePointLength("")).toBe(0);
    expect(codePointLength("abc")).toBe(3);
    // A single astral character is two UTF-16 units but ONE code point.
    expect("\u{1F600}".length).toBe(2);
    expect(codePointLength("\u{1F600}")).toBe(1);
    expect(codePointLength("a\u{1F600}b")).toBe(3);
  });
});

describe("damerauLevenshteinCodePoints", () => {
  it("measures distance over code points including transposition", () => {
    expect(damerauLevenshteinCodePoints("abc", "abc")).toBe(0);
    expect(damerauLevenshteinCodePoints("abc", "abd")).toBe(1);
    expect(damerauLevenshteinCodePoints("ab", "ba")).toBe(1);
    expect(damerauLevenshteinCodePoints("separate", "seperate")).toBe(1);
  });

  it("treats an astral character as a single unit of distance", () => {
    // Two DIFFERENT astral emoji differ by exactly one code-point substitution, even though each is two
    // UTF-16 units — the raw package would score this 2.
    const distance = damerauLevenshteinCodePoints("\u{1F600}", "\u{1F601}");
    expect(distance).toBe(1);
    // Inserting one astral character is one edit, not two.
    expect(damerauLevenshteinCodePoints("a", "a\u{1F600}")).toBe(1);
  });

  it("is symmetric", () => {
    expect(damerauLevenshteinCodePoints("kitten", "sitting")).toBe(
      damerauLevenshteinCodePoints("sitting", "kitten")
    );
  });
});

describe("nearMatchScore", () => {
  it("scores 1 - distance / max code-point length", () => {
    expect(nearMatchScore("hello", "hello")).toBe(1);
    // One deletion over a max length of 11.
    expect(nearMatchScore("in terms of", "in term of")).toBeCloseTo(1 - 1 / 11, 10);
    // One substitution over eight.
    expect(nearMatchScore("separate", "seperate")).toBeCloseTo(1 - 1 / 8, 10);
  });

  it("returns 1 for two empty strings and 0 for empty against non-empty", () => {
    expect(nearMatchScore("", "")).toBe(1);
    expect(nearMatchScore("", "abc")).toBe(0);
    expect(nearMatchScore("abc", "")).toBe(0);
  });

  it("stays within [0, 1] and is symmetric", () => {
    const a = "the quick brown fox";
    const b = "the quikc brwon fox";
    const score = nearMatchScore(a, b);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(nearMatchScore(a, b)).toBe(nearMatchScore(b, a));
  });
});

describe("nearMatchLengthBand", () => {
  it("brackets the target length by the threshold", () => {
    // ceil(0.84 * 10) = 9, floor(10 / 0.84) = 11.
    expect(nearMatchLengthBand(10, 0.84)).toEqual({ max: 11, min: 9 });
  });

  it("is a COMPLETE prefilter: any length that could clear the threshold is inside the band", () => {
    const threshold = 0.84;
    for (let length = 8; length <= 240; length += 1) {
      const band = nearMatchLengthBand(length, threshold);
      for (let other = 1; other <= 260; other += 1) {
        // The best possible score for two keys of these lengths uses distance = |length - other| (the
        // minimum edit distance any alignment can have). If that best score reaches the threshold, the band
        // must include `other`, or the prefilter would wrongly drop a real match.
        const bestPossible = 1 - Math.abs(length - other) / Math.max(length, other);
        if (bestPossible >= threshold) {
          expect(other).toBeGreaterThanOrEqual(band.min);
          expect(other).toBeLessThanOrEqual(band.max);
        }
      }
    }
  });
});
