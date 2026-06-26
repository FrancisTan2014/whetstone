import { describe, expect, it } from "vitest";

import { motionSprings, withReducedMotion } from "./motion.js";

describe("withReducedMotion", () => {
  it("returns the requested transition when motion is allowed", () => {
    expect(withReducedMotion(motionSprings.gentle, false)).toBe(motionSprings.gentle);
  });

  it("returns an instant transition under reduced motion", () => {
    expect(withReducedMotion(motionSprings.snappy, true)).toEqual({ duration: 0 });
  });
});
