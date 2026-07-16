import { describe, expect, it } from "vitest";

import { isRecitationPhase, recitationPhases, recitationRatingChoices } from "./index.js";

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

describe("recitation rating choices", () => {
  it("maps the four learner-facing choices onto the FSRS ratings worst→best", () => {
    expect(recitationRatingChoices.map((choice) => choice.rating)).toEqual([
      "again",
      "hard",
      "good",
      "easy"
    ]);
  });

  it("gives every choice a distinct human label", () => {
    const labels = recitationRatingChoices.map((choice) => choice.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });
});
