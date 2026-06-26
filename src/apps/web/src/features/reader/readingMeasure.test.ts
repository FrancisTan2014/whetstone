import { describe, expect, it } from "vitest";

import { readingMeasureRem } from "./readingMeasure";

describe("readingMeasureRem", () => {
  it("returns the Latin measure for English in a font-size-independent rem unit", () => {
    expect(readingMeasureRem("en")).toBe("44rem");
  });

  it("returns the wider CJK measure for Simplified and Traditional Chinese", () => {
    expect(readingMeasureRem("zh-CN")).toBe("46rem");
    expect(readingMeasureRem("zh-TW")).toBe("46rem");
  });

  it("expresses every measure in rem so the column width never scales with the text size", () => {
    for (const language of ["en", "zh-CN", "zh-TW"]) {
      expect(readingMeasureRem(language)).toMatch(/rem$/u);
    }
  });
});
