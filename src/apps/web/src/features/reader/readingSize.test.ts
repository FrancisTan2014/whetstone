import { describe, expect, it } from "vitest";

import {
  defaultReadingSize,
  isLargestReadingSize,
  isSmallestReadingSize,
  largerReadingSize,
  readingSizeToRem,
  readingSizes,
  smallerReadingSize
} from "./readingSize.js";

describe("readingSize", () => {
  it("defaults to the medium step and maps each step to a rem size", () => {
    expect(defaultReadingSize).toBe("md");
    for (const size of readingSizes) {
      expect(readingSizeToRem(size)).toMatch(/rem$/u);
    }
  });

  it("steps up and clamps at the largest size", () => {
    expect(largerReadingSize("sm")).toBe("md");
    expect(largerReadingSize("lg")).toBe("xl");
    expect(largerReadingSize("xl")).toBe("xl");
  });

  it("steps down and clamps at the smallest size", () => {
    expect(smallerReadingSize("xl")).toBe("lg");
    expect(smallerReadingSize("md")).toBe("sm");
    expect(smallerReadingSize("sm")).toBe("sm");
  });

  it("recognizes only the first/last steps as the min/max bounds", () => {
    expect(isSmallestReadingSize("sm")).toBe(true);
    expect(isSmallestReadingSize("md")).toBe(false);
    expect(isSmallestReadingSize("xl")).toBe(false);
    expect(isLargestReadingSize("xl")).toBe(true);
    expect(isLargestReadingSize("lg")).toBe(false);
    expect(isLargestReadingSize("sm")).toBe(false);
  });
});
