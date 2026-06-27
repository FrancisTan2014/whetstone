import { describe, expect, it } from "vitest";

import {
  parseCompiledLearnerContextDto,
  parseDepositTurnOutcomeRequest,
  parseLearnerProfileDto
} from "./learnerContracts.js";

describe("parseDepositTurnOutcomeRequest", () => {
  it("accepts a minimal outcome (grade only)", () => {
    expect(parseDepositTurnOutcomeRequest({ grade: 4 })).toEqual({ grade: 4 });
  });

  it("accepts a chunk link and an error category", () => {
    const request = { chunkId: "kitchen.meal_planning.x", errorCategory: "article_drop", grade: 2 };
    expect(parseDepositTurnOutcomeRequest(request)).toEqual(request);
  });

  it("rejects an out-of-range grade", () => {
    expect(() => parseDepositTurnOutcomeRequest({ grade: 6 })).toThrow();
  });

  it("rejects a blank chunk id", () => {
    expect(() => parseDepositTurnOutcomeRequest({ chunkId: "  ", grade: 1 })).toThrow();
  });

  it("rejects an unknown error category", () => {
    expect(() => parseDepositTurnOutcomeRequest({ errorCategory: "typo", grade: 1 })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => parseDepositTurnOutcomeRequest({ grade: 1, userId: "u" })).toThrow();
  });
});

describe("parseLearnerProfileDto", () => {
  const profile = {
    focus: "kitchen.meal_planning",
    level: "intermediate",
    strengths: ["Kitchen & cooking"],
    summary: "A profile.",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weaknesses: ["article_drop"]
  };

  it("round-trips a valid profile", () => {
    expect(parseLearnerProfileDto(profile)).toEqual(profile);
  });

  it("rejects an unknown level", () => {
    expect(() => parseLearnerProfileDto({ ...profile, level: "fluent" })).toThrow();
  });
});

describe("parseCompiledLearnerContextDto", () => {
  const context = {
    profile: null,
    rankedChunks: [
      {
        caseId: "kitchen.meal_planning",
        chunkId: "kitchen.meal_planning.x",
        domainId: "kitchen",
        frequency: 0.9,
        gap: 1,
        score: 0.9,
        status: "new"
      }
    ],
    recentOutcomes: [
      { chunkId: null, errorCategory: null, grade: 4, recordedAt: "2026-01-01T00:00:00.000Z" }
    ],
    relevantErrors: [{ category: "article_drop", count: 3, lastSeenAt: "2026-01-01T00:00:00.000Z" }]
  };

  it("round-trips a bounded context (null profile)", () => {
    expect(parseCompiledLearnerContextDto(context)).toEqual(context);
  });

  it("rejects an error pattern with a non-positive count", () => {
    expect(() =>
      parseCompiledLearnerContextDto({
        ...context,
        relevantErrors: [{ category: "register", count: 0, lastSeenAt: "x" }]
      })
    ).toThrow();
  });

  it("rejects a ranked chunk with an unknown status", () => {
    expect(() =>
      parseCompiledLearnerContextDto({
        ...context,
        rankedChunks: [{ ...context.rankedChunks[0], status: "forgotten" }]
      })
    ).toThrow();
  });
});
