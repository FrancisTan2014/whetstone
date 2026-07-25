import levenshtein from "damerau-levenshtein";

// The guarded near-Note scorer (#713): the SINGLE, characterization-locked source of edit distance and
// similarity the near matcher uses. Fuzzy distance is a conservative review signal, never identity, so it is
// reached only through this pure adapter over pinned `damerau-levenshtein@1.0.8` — never a hand-rolled
// distance and never the block Dice reuse — and every behaviour the matcher depends on (distance,
// transposition, empty, and astral-Unicode) is pinned by its characterization tests.
//
// The library measures edit distance in UTF-16 code UNITS; the matcher's contract is code POINTS (an astral
// character is one unit of meaning, not two, and the relaxed key's length is measured in code points). So
// both operands are first re-encoded to a private-use alphabet — one BMP code unit per DISTINCT code point,
// shared across the pair so equal code points map alike — making the library's code-unit distance a true
// code-point distance. For the ASCII prose the matcher actually scores this is an identity re-encoding, but
// it keeps the distance correct for any string the characterization tests throw at it.

// Base of the Basic Multilingual Plane Private Use Area (U+E000). Each distinct code point in a compared pair
// maps to one consecutive code unit from here, so the re-encoded strings hold exactly one unit per input code
// point. The 6,400-slot PUA dwarfs the ≤240-code-point relaxed keys the matcher compares.
const PRIVATE_USE_BASE = 0xe000;

// The number of Unicode code points in a string (NOT its UTF-16 `.length`): the matcher's denominator and
// eligibility bound are both measured in code points, so an astral character counts once.
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

// Re-encode `text` so each distinct code point becomes one BMP code unit, extending the shared `alphabet`
// with any code point not yet seen. Iterating with `for..of` walks code points (not surrogate halves), so an
// astral character contributes exactly one mapped unit.
function toCodePointComparable(text: string, alphabet: Map<number, string>): string {
  let encoded = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    let mapped = alphabet.get(codePoint);
    if (mapped === undefined) {
      mapped = String.fromCharCode(PRIVATE_USE_BASE + alphabet.size);
      alphabet.set(codePoint, mapped);
    }
    encoded += mapped;
  }
  return encoded;
}

// The Damerau-Levenshtein distance between two strings measured in code points (adjacent transpositions cost
// one edit). Pure and deterministic.
export function damerauLevenshteinCodePoints(a: string, b: string): number {
  const alphabet = new Map<number, string>();
  return levenshtein(toCodePointComparable(a, alphabet), toCodePointComparable(b, alphabet)).steps;
}

// The near-match similarity of two relaxed keys: `1 - distance / max(codePointLength)`, so an edit weighs
// against the LONGER string and the score is a bounded `[0, 1]` ratio (1 = identical, 0 = wholly different).
// Two empty strings are identical (1); an empty against a non-empty scores 0 through the max-length divisor.
export function nearMatchScore(a: string, b: string): number {
  const longest = Math.max(codePointLength(a), codePointLength(b));
  if (longest === 0) {
    return 1;
  }
  return 1 - damerauLevenshteinCodePoints(a, b) / longest;
}

// The complete length prefilter for a relaxed key of `length` at `threshold`: the inclusive `[min, max]`
// band of candidate relaxed-key lengths that could POSSIBLY score at or above the threshold. A pair's edit
// distance is at least the gap between their lengths, so `score <= 1 - |length - L| / max(length, L)`;
// requiring that upper bound to reach the threshold gives `L ∈ [ceil(threshold·length), floor(length /
// threshold)]`. Because the bound only ever OVER-estimates the score, the band can never drop a pair whose
// real score would clear the threshold — it is a sound, complete prefilter, not a heuristic.
export function nearMatchLengthBand(
  length: number,
  threshold: number
): Readonly<{ max: number; min: number }> {
  return { max: Math.floor(length / threshold), min: Math.ceil(threshold * length) };
}
