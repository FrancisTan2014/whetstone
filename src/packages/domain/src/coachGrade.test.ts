import { describe, expect, it } from "vitest";

import { judgementToGrade, productionCategories } from "./coachGrade.js";

describe("judgementToGrade", () => {
  it.each([
    ["off_target", 0],
    ["incorrect", 1],
    ["awkward", 2],
    ["understandable", 3],
    ["good", 4],
    ["native_like", 5]
  ] as const)("maps %s to SM-2 grade %i", (category, grade) => {
    expect(judgementToGrade(category)).toBe(grade);
  });

  it("covers every category with a distinct grade in 0..5", () => {
    const grades = productionCategories.map(judgementToGrade);
    expect(new Set(grades).size).toBe(productionCategories.length);
    for (const grade of grades) {
      expect(Number.isInteger(grade)).toBe(true);
      expect(grade).toBeGreaterThanOrEqual(0);
      expect(grade).toBeLessThanOrEqual(5);
    }
  });
});
