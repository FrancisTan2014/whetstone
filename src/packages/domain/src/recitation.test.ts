import { describe, expect, it } from "vitest";

import { isRecitationPhase, recitationPhases } from "./index.js";

describe("recitation phase vocabulary", () => {
  it("names the three learner-driven phases in progression order", () => {
    expect(recitationPhases).toEqual(["familiarizing", "learning", "maintenance"]);
  });

  it("recognizes only the real phases", () => {
    for (const phase of recitationPhases) {
      expect(isRecitationPhase(phase)).toBe(true);
    }
    expect(isRecitationPhase("reciting")).toBe(false);
    expect(isRecitationPhase("")).toBe(false);
    expect(isRecitationPhase(undefined)).toBe(false);
    expect(isRecitationPhase(2)).toBe(false);
  });
});
