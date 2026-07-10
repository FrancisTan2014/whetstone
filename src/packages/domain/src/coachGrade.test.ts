import { describe, expect, it } from "vitest";

import { judgementToRating, productionCategories } from "./coachGrade.js";
import { type ReviewRating } from "./fsrs.js";

describe("judgementToRating", () => {
  it.each([
    ["off_target", "again"],
    ["incorrect", "again"],
    ["awkward", "hard"],
    ["understandable", "hard"],
    ["good", "good"],
    ["native_like", "easy"]
  ] as const)("maps %s to FSRS rating %s", (category, rating) => {
    expect(judgementToRating(category)).toBe(rating);
  });

  it("maps every category to one of the four FSRS ratings, worst -> best monotonically", () => {
    const order: ReadonlyArray<ReviewRating> = ["again", "hard", "good", "easy"];
    const ranks = productionCategories.map((category) =>
      order.indexOf(judgementToRating(category))
    );
    for (const rank of ranks) {
      expect(rank).toBeGreaterThanOrEqual(0);
    }
    // The verdict ladder never regresses as categories improve, and uses every rating.
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1] as number);
    }
    expect(new Set(ranks).size).toBe(order.length);
  });
});
