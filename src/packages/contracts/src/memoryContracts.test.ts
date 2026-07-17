import { describe, expect, it } from "vitest";

import { createTextDocument } from "@whetstone/document";

import {
  captureSourceSchema,
  memoryDocumentSchema,
  ratingSchema,
  reviewStateDtoSchema
} from "./memoryContracts.js";

describe("memoryDocumentSchema", () => {
  it("accepts a valid document node and rejects a malformed one", () => {
    const doc = createTextDocument("遠慮");
    expect(memoryDocumentSchema.parse(doc)).toEqual(doc);
    expect(() => memoryDocumentSchema.parse({ type: "not-a-document" })).toThrow(/valid document/);
  });
});

describe("captureSourceSchema", () => {
  it("accepts a known capture source and rejects an unknown one", () => {
    expect(captureSourceSchema.parse("manual")).toBe("manual");
    expect(() => captureSourceSchema.parse("speech")).toThrow();
  });
});

describe("reviewStateDtoSchema", () => {
  const review = {
    due: "2026-07-11T00:00:00.000Z",
    stability: 1,
    difficulty: 5,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: "new",
    lastReviewedAt: null
  } as const;

  it("round-trips a scheduled card state", () => {
    expect(reviewStateDtoSchema.parse(review)).toEqual(review);
  });

  it("rejects a non-integer field and an unknown extra field (strict)", () => {
    expect(() => reviewStateDtoSchema.parse({ ...review, reps: 1.5 })).toThrow();
    expect(() => reviewStateDtoSchema.parse({ ...review, extra: 1 })).toThrow();
  });
});

describe("ratingSchema", () => {
  it("accepts each FSRS rating and rejects an unknown one", () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      expect(ratingSchema.parse(rating)).toBe(rating);
    }
    expect(() => ratingSchema.parse("meh")).toThrow();
  });
});
