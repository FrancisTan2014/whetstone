import { describe, expect, it } from "vitest";

import { deriveCoachKnobs, type LearnerSnapshot } from "./coachKnobs.js";

function snapshot(overrides: Partial<LearnerSnapshot> = {}): LearnerSnapshot {
  return {
    band: "intermediate",
    dueChunkCount: 3,
    focus: "kitchen.offering-food",
    recentGrades: [3, 3],
    topErrorPatterns: [],
    ...overrides
  };
}

describe("deriveCoachKnobs", () => {
  it("gives a beginner with no history low challenge and high support", () => {
    const knobs = deriveCoachKnobs(snapshot({ band: "beginner", recentGrades: [] }));

    expect(knobs.targetBand).toBe("beginner");
    expect(knobs.challenge).toBe("low");
    expect(knobs.support).toBe("high");
    expect(knobs.pace).toBe("slow");
    expect(knobs.register).toBe("casual");
  });

  it("pushes an advancing learner up a band with more challenge and less support", () => {
    const knobs = deriveCoachKnobs(snapshot({ band: "intermediate", recentGrades: [5, 4, 5] }));

    expect(knobs.targetBand).toBe("advanced");
    expect(knobs.challenge).toBe("high");
    expect(knobs.support).toBe("low");
    expect(knobs.pace).toBe("brisk");
    expect(knobs.register).toBe("formal");
  });

  it("does not push past the top band", () => {
    expect(deriveCoachKnobs(snapshot({ band: "advanced", recentGrades: [5, 5] })).targetBand).toBe(
      "advanced"
    );
  });

  it("eases off for a struggling learner (lower challenge, more support)", () => {
    const knobs = deriveCoachKnobs(snapshot({ band: "elementary", recentGrades: [1, 2, 1] }));

    expect(knobs.targetBand).toBe("elementary");
    expect(knobs.challenge).toBe("low");
    expect(knobs.support).toBe("high");
  });

  it("holds a steady learner at their band's baseline", () => {
    const knobs = deriveCoachKnobs(snapshot({ band: "intermediate", recentGrades: [3, 3] }));

    expect(knobs.targetBand).toBe("intermediate");
    expect(knobs.challenge).toBe("medium");
    expect(knobs.support).toBe("medium");
  });

  it("probes the learner's top recurring error patterns, capped at two", () => {
    const knobs = deriveCoachKnobs(
      snapshot({ topErrorPatterns: ["article_drop", "l1_calque", "word_order"] })
    );

    expect(knobs.probeErrorPatterns).toEqual(["article_drop", "l1_calque"]);
  });

  it("carries the model's focus topic through unchanged", () => {
    expect(deriveCoachKnobs(snapshot({ focus: "errands.post-office" })).focus).toBe(
      "errands.post-office"
    );
  });

  it("is deterministic — the same snapshot yields the same knobs", () => {
    const input = snapshot({ band: "elementary", recentGrades: [4, 4, 4] });
    expect(deriveCoachKnobs(input)).toEqual(deriveCoachKnobs(input));
  });
});
