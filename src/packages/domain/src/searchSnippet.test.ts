import { describe, expect, it } from "vitest";

import { buildSearchSnippet, SEARCH_SNIPPET_MAX_CODE_POINTS } from "./searchSnippet.js";

// Locate a substring's code-point start the way the database does (over the source), so the test
// feeds `buildSearchSnippet` the same authoritative input the query supplies.
function codePointIndexOf(text: string, needle: string): number {
  const before = text.slice(0, text.indexOf(needle));
  return Array.from(before).length;
}

function snippetFor(plaintext: string, needle: string, maxCodePoints?: number) {
  return buildSearchSnippet({
    plaintext,
    matchStartCodePoint: codePointIndexOf(plaintext, needle),
    matchLengthCodePoints: Array.from(needle).length,
    // `maxCodePoints` is optional under `exactOptionalPropertyTypes`, so omit the key entirely
    // rather than passing an explicit `undefined` the parameter type does not accept.
    ...(maxCodePoints === undefined ? {} : { maxCodePoints })
  });
}

describe("buildSearchSnippet", () => {
  it("returns the whole block unclipped when it fits the budget", () => {
    const result = snippetFor("The dog barked loudly.", "dog");

    expect(result.text).toBe("The dog barked loudly.");
    expect(result.hasLeadingEllipsis).toBe(false);
    expect(result.hasTrailingEllipsis).toBe(false);
    expect(result.text.slice(result.matchStart, result.matchEnd)).toBe("dog");
  });

  it("clips both sides with balanced context and marks both ellipses when the block overflows", () => {
    const plaintext = `${"a".repeat(500)}NEEDLE${"b".repeat(500)}`;
    const result = snippetFor(plaintext, "NEEDLE", 20);

    expect(Array.from(result.text)).toHaveLength(20);
    expect(result.hasLeadingEllipsis).toBe(true);
    expect(result.hasTrailingEllipsis).toBe(true);
    expect(result.text.slice(result.matchStart, result.matchEnd)).toBe("NEEDLE");
    // budget 20 - match 6 = 14 context, floor(14/2)=7 before, 7 after.
    expect(result.text).toBe(`${"a".repeat(7)}NEEDLE${"b".repeat(7)}`);
  });

  it("gives no leading ellipsis and redistributes context when the match sits at the start", () => {
    const plaintext = `NEEDLE${"b".repeat(500)}`;
    const result = snippetFor(plaintext, "NEEDLE", 20);

    expect(result.hasLeadingEllipsis).toBe(false);
    expect(result.hasTrailingEllipsis).toBe(true);
    expect(result.matchStart).toBe(0);
    // No room before, so all 14 context code points go after the match.
    expect(result.text).toBe(`NEEDLE${"b".repeat(14)}`);
  });

  it("gives no trailing ellipsis and redistributes context when the match sits at the end", () => {
    const plaintext = `${"a".repeat(500)}NEEDLE`;
    const result = snippetFor(plaintext, "NEEDLE", 20);

    expect(result.hasLeadingEllipsis).toBe(true);
    expect(result.hasTrailingEllipsis).toBe(false);
    expect(result.text).toBe(`${"a".repeat(14)}NEEDLE`);
    expect(result.text.slice(result.matchStart, result.matchEnd)).toBe("NEEDLE");
  });

  it("caps the window at the budget in Unicode code points, not UTF-16 units, for astral text", () => {
    // Each 😀 is one code point but two UTF-16 units. A budget counted in UTF-16 units would clip early.
    const plaintext = `${"😀".repeat(300)}dog${"😀".repeat(300)}`;
    const result = snippetFor(plaintext, "dog", 20);

    expect(Array.from(result.text)).toHaveLength(20);
    expect(result.text.slice(result.matchStart, result.matchEnd)).toBe("dog");
  });

  it("reports canonical UTF-16 offsets across astral characters before the match", () => {
    // 3 astral code points precede the match: 6 UTF-16 units. Naive code-point indexing would say 3.
    const result = snippetFor("😀😀😀dog", "dog");

    expect(result.matchStart).toBe(6);
    expect(result.matchEnd).toBe(9);
    expect(result.text.slice(result.matchStart, result.matchEnd)).toBe("dog");
  });

  it("locates the FIRST match's offsets when the term repeats", () => {
    const result = snippetFor("dog and dog and dog", "dog");

    expect(result.matchStart).toBe(0);
    expect(result.matchEnd).toBe(3);
  });

  it("shows the leading window of a match longer than the whole budget", () => {
    const plaintext = "z".repeat(300);
    const result = buildSearchSnippet({
      plaintext,
      matchStartCodePoint: 0,
      matchLengthCodePoints: 300,
      maxCodePoints: 20
    });

    expect(Array.from(result.text)).toHaveLength(20);
    expect(result.matchStart).toBe(0);
    expect(result.matchEnd).toBe(20);
    expect(result.hasTrailingEllipsis).toBe(true);
    expect(result.hasLeadingEllipsis).toBe(false);
  });

  it("clamps an out-of-range match position into the source bounds", () => {
    const result = buildSearchSnippet({
      plaintext: "short",
      matchStartCodePoint: 999,
      matchLengthCodePoints: 3
    });

    expect(result.matchStart).toBe("short".length);
    expect(result.matchEnd).toBe("short".length);
    expect(result.text).toBe("short");
  });

  it("clamps a negative match position to the start of the source", () => {
    const result = buildSearchSnippet({
      plaintext: "hello",
      matchStartCodePoint: -5,
      matchLengthCodePoints: 2
    });

    expect(result.matchStart).toBe(0);
    expect(result.matchEnd).toBe(2);
    expect(result.text).toBe("hello");
  });

  it("defaults to the shared 220 code-point budget", () => {
    const plaintext = `${"a".repeat(400)}dog${"b".repeat(400)}`;
    const result = snippetFor(plaintext, "dog");

    expect(Array.from(result.text)).toHaveLength(SEARCH_SNIPPET_MAX_CODE_POINTS);
  });
});
