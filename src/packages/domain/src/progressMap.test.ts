import { describe, expect, it } from "vitest";

import { caseLightLevel } from "./progressMap.js";

function summary(overrides: {
  due?: number;
  learning?: number;
  mastered?: number;
  newChunks?: number;
  total: number;
}) {
  return {
    dueChunks: overrides.due ?? 0,
    learningChunks: overrides.learning ?? 0,
    masteredChunks: overrides.mastered ?? 0,
    newChunks: overrides.newChunks ?? 0,
    totalChunks: overrides.total
  };
}

describe("caseLightLevel", () => {
  it("is dark for an empty case", () => {
    expect(caseLightLevel(summary({ total: 0 }))).toBe("dark");
  });

  it("is dark when every chunk is still new", () => {
    expect(caseLightLevel(summary({ newChunks: 6, total: 6 }))).toBe("dark");
  });

  it("is lit when every chunk is mastered", () => {
    expect(caseLightLevel(summary({ mastered: 6, total: 6 }))).toBe("lit");
  });

  it("is dim when some chunks are started but not all mastered", () => {
    expect(caseLightLevel(summary({ learning: 1, mastered: 2, newChunks: 3, total: 6 }))).toBe(
      "dim"
    );
  });

  it("is dim when there is a due chunk among new ones", () => {
    expect(caseLightLevel(summary({ due: 1, newChunks: 5, total: 6 }))).toBe("dim");
  });
});
