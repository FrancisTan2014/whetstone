import { describe, expect, it } from "vitest";

import { chunkMasteryStatus, summarizeCaseMastery } from "./caseMastery.js";
import type { ReviewState } from "./sm2.js";

const now = new Date("2026-01-10T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const offsetFromNow = (days: number): string => new Date(now.getTime() + days * day).toISOString();

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    dueAt: offsetFromNow(7),
    easeFactor: 2.5,
    intervalDays: 7,
    lapses: 0,
    lastReviewedAt: offsetFromNow(-1),
    repetitions: 1,
    ...overrides
  };
}

describe("chunkMasteryStatus", () => {
  it("is 'new' when the learner has no linked items", () => {
    expect(chunkMasteryStatus([], now)).toBe("new");
  });

  it("is 'due' when an item is due now (boundary: due exactly at now)", () => {
    expect(chunkMasteryStatus([state({ dueAt: now.toISOString() })], now)).toBe("due");
  });

  it("is 'learning' when enrolled, not due, and not yet graduated", () => {
    expect(chunkMasteryStatus([state({ repetitions: 2 })], now)).toBe("learning");
  });

  it("is 'mastered' when every item has graduated and none is due", () => {
    expect(chunkMasteryStatus([state({ repetitions: 3 })], now)).toBe("mastered");
  });

  it("is 'learning' when only some linked items have graduated", () => {
    expect(chunkMasteryStatus([state({ repetitions: 4 }), state({ repetitions: 1 })], now)).toBe(
      "learning"
    );
  });

  it("prefers 'due' over 'mastered' when a graduated item has come due again", () => {
    expect(
      chunkMasteryStatus(
        [state({ repetitions: 5 }), state({ repetitions: 5, dueAt: offsetFromNow(-1) })],
        now
      )
    ).toBe("due");
  });
});

describe("summarizeCaseMastery", () => {
  it("classifies each chunk and counts the buckets (counts sum to total)", () => {
    const chunkIds = ["a", "b", "c", "d", "e"];
    const statesByChunkId = new Map<string, ReviewState[]>([
      ["b", [state({ dueAt: offsetFromNow(-1) })]],
      ["c", [state({ repetitions: 3 })]],
      ["d", [state({ repetitions: 2 })]]
      // "a" present with no entry and "e" absent both count as new.
    ]);

    expect(summarizeCaseMastery(chunkIds, statesByChunkId, now)).toEqual({
      dueChunks: 1,
      learningChunks: 1,
      masteredChunks: 1,
      newChunks: 2,
      totalChunks: 5
    });
  });

  it("treats an empty case as all-zero", () => {
    expect(summarizeCaseMastery([], new Map(), now)).toEqual({
      dueChunks: 0,
      learningChunks: 0,
      masteredChunks: 0,
      newChunks: 0,
      totalChunks: 0
    });
  });

  it("treats an explicit empty state list as 'new'", () => {
    expect(summarizeCaseMastery(["a"], new Map([["a", []]]), now)).toMatchObject({
      newChunks: 1,
      totalChunks: 1
    });
  });
});
