import { describe, expect, it } from "vitest";

import { parseProgressMapDto } from "./mapContracts.js";

const mastery = {
  caseId: "kitchen.meal_planning",
  dueChunks: 0,
  learningChunks: 1,
  masteredChunks: 2,
  newChunks: 4,
  totalChunks: 7
};

const map = {
  domains: [
    {
      cases: [
        {
          caseId: "kitchen.meal_planning",
          communicativeFunction: "Proposing a plan",
          light: "dim",
          mastery,
          recommended: true,
          situation: "Planning a meal"
        }
      ],
      domain: { id: "kitchen", name: "Kitchen & cooking", weight: 0.9 }
    }
  ],
  recommendedCaseId: "kitchen.meal_planning",
  signals: {
    errorTrend: [{ category: "article_drop", count: 3, lastSeenAt: "2026-01-01T00:00:00.000Z" }],
    ownedChunks: 2,
    summary: "You own 2 of 7 everyday phrasings; 1 need review.",
    totalChunks: 7,
    weakChunks: 1
  }
};

describe("parseProgressMapDto", () => {
  it("round-trips a full progress map", () => {
    expect(parseProgressMapDto(map)).toEqual(map);
  });

  it("accepts a null recommendation", () => {
    expect(parseProgressMapDto({ ...map, recommendedCaseId: null }).recommendedCaseId).toBeNull();
  });

  it("rejects an unknown light level", () => {
    const broken = {
      ...map,
      domains: [{ ...map.domains[0], cases: [{ ...map.domains[0]?.cases[0], light: "glowing" }] }]
    };
    expect(() => parseProgressMapDto(broken)).toThrow();
  });

  it("rejects a non-integer owned count", () => {
    expect(() =>
      parseProgressMapDto({ ...map, signals: { ...map.signals, ownedChunks: 1.5 } })
    ).toThrow();
  });
});
