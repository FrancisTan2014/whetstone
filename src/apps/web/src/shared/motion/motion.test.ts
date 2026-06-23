import { describe, expect, it } from "vitest";

import { motionDurations, motionEasings, motionSprings, withReducedMotion } from "./motion.js";

describe("motion", () => {
  it("returns the requested transition when motion is allowed", () => {
    expect(withReducedMotion(motionSprings.gentle, false)).toBe(motionSprings.gentle);
  });

  it("returns an instant transition under reduced motion", () => {
    expect(withReducedMotion(motionSprings.snappy, true)).toEqual({ duration: 0 });
  });

  it("exposes named duration, easing, and spring tokens", () => {
    expect(motionDurations.base).toBeGreaterThan(0);
    expect(motionEasings.standard).toHaveLength(4);
    expect(motionSprings.gentle.type).toBe("spring");
  });
});
