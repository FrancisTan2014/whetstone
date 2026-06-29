import { describe, expect, it } from "vitest";

import { englishShare, MAX_L1_SHARE, targetL1Share } from "./languageMix.js";

describe("englishShare", () => {
  it("is 1 for all-English text", () => {
    expect(englishShare("Could you pass the salt please")).toBe(1);
  });

  it("is 0 for all-Chinese text", () => {
    expect(englishShare("请把盐递给我")).toBe(0);
  });

  it("is the Latin-over-Latin+CJK ratio for a mixed turn", () => {
    // 4 Latin letters ("pass") + 4 CJK characters -> 0.5.
    expect(englishShare("pass 请把盐递")).toBeCloseTo(4 / 8);
  });

  it("ignores digits, punctuation, and spaces", () => {
    expect(englishShare("ok! 123 ok?")).toBe(1);
  });

  it("counts a turn with no scorable letters as fully English", () => {
    expect(englishShare("123 !!! ...")).toBe(1);
    expect(englishShare("")).toBe(1);
  });
});

describe("targetL1Share", () => {
  it("is 0 for an English-only learner regardless of share", () => {
    expect(targetL1Share("none", 0)).toBe(0);
    expect(targetL1Share("none", 1)).toBe(0);
  });

  it("is the inverse of the English share for an L1 learner, capped at the max", () => {
    expect(targetL1Share("zh", 1)).toBe(0);
    expect(targetL1Share("zh", 0.6)).toBeCloseTo(0.4);
    // 1 - 0.1 = 0.9 is capped to MAX_L1_SHARE so the coach always pushes some English.
    expect(targetL1Share("zh", 0.1)).toBe(MAX_L1_SHARE);
  });

  it("never goes negative", () => {
    expect(targetL1Share("zh", 1.5)).toBe(0);
  });
});
