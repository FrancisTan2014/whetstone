import { describe, expect, it } from "vitest";

import { chunkMasteryStatus, summarizeCaseMastery } from "./caseMastery.js";
import type { CardState, ReviewState } from "./fsrs.js";

const now = new Date("2026-01-10T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const offsetFromNow = (days: number): string => new Date(now.getTime() + days * day).toISOString();

// Build an FSRS ReviewState directly (bypassing the scheduler) so each mastery predicate can be
// exercised at its boundary. Defaults to a graduated "review" card, not due, with a short interval —
// i.e. "learning" (enrolled, not due, not yet mastered).
function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    due: offsetFromNow(7),
    stability: 8,
    difficulty: 5,
    elapsedDays: 3,
    scheduledDays: 7,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: "review" as CardState,
    lastReviewedAt: offsetFromNow(-1),
    ...overrides
  };
}

describe("chunkMasteryStatus", () => {
  it("is 'new' when the learner has no linked items", () => {
    expect(chunkMasteryStatus([], now)).toBe("new");
  });

  it("is 'due' when an item is due now (boundary: due exactly at now)", () => {
    expect(chunkMasteryStatus([state({ due: now.toISOString() })], now)).toBe("due");
  });

  it("is 'learning' when a card is still in the learning state (not yet graduated)", () => {
    expect(chunkMasteryStatus([state({ state: "learning", scheduledDays: 30 })], now)).toBe(
      "learning"
    );
  });

  it("is 'mastered' at the 21-day interval boundary (review card, not due)", () => {
    expect(chunkMasteryStatus([state({ scheduledDays: 21 })], now)).toBe("mastered");
  });

  it("is 'learning' just below the 21-day interval boundary", () => {
    expect(chunkMasteryStatus([state({ scheduledDays: 20 })], now)).toBe("learning");
  });

  it("is not mastered when a long-interval card is in relearning, not review", () => {
    expect(chunkMasteryStatus([state({ state: "relearning", scheduledDays: 40 })], now)).toBe(
      "learning"
    );
  });

  it("is 'learning' when only some linked items have graduated", () => {
    expect(
      chunkMasteryStatus([state({ scheduledDays: 40 }), state({ scheduledDays: 5 })], now)
    ).toBe("learning");
  });

  it("is 'mastered' when every item has graduated and none is due", () => {
    expect(
      chunkMasteryStatus([state({ scheduledDays: 30 }), state({ scheduledDays: 60 })], now)
    ).toBe("mastered");
  });

  it("prefers 'due' over 'mastered' when a graduated item has come due again", () => {
    expect(
      chunkMasteryStatus(
        [state({ scheduledDays: 60 }), state({ scheduledDays: 60, due: offsetFromNow(-1) })],
        now
      )
    ).toBe("due");
  });
});

describe("summarizeCaseMastery", () => {
  it("classifies each chunk and counts the buckets (counts sum to total)", () => {
    const chunkIds = ["a", "b", "c", "d", "e"];
    const statesByChunkId = new Map<string, ReviewState[]>([
      ["b", [state({ due: offsetFromNow(-1) })]],
      ["c", [state({ scheduledDays: 30 })]],
      ["d", [state({ scheduledDays: 5 })]]
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
