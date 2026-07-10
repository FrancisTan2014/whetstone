import { describe, expect, it } from "vitest";

import {
  applyRating,
  cardStates,
  isDue,
  newReviewState,
  RECALL_REQUEST_RETENTION,
  retrievability,
  type ReviewRating,
  type ReviewState
} from "./fsrs.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const deterministic = { enableFuzz: false } as const;
const minute = 60 * 1000;
const day = 24 * 60 * 60 * 1000;

describe("newReviewState", () => {
  it("is a fresh, never-reviewed card due immediately at `now`", () => {
    const state = newReviewState(now);
    expect(state).toEqual({
      due: now.toISOString(),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: "new",
      lastReviewedAt: null
    });
  });

  it("exposes the requested-retention parameter and card-state vocabulary", () => {
    expect(RECALL_REQUEST_RETENTION).toBe(0.9);
    expect(cardStates).toEqual(["new", "learning", "review", "relearning"]);
  });
});

describe("applyRating from a new card", () => {
  it.each([
    ["again", "learning", 1 * minute],
    ["hard", "learning", 6 * minute],
    ["good", "learning", 10 * minute],
    ["easy", "review", 8 * day]
  ] as const)(
    "rating %s advances due, sets reps to 1, and stamps the review time",
    (rating: ReviewRating, expectedState, dueDeltaMs) => {
      const next = applyRating(newReviewState(now), rating, now, deterministic);
      expect(next.state).toBe(expectedState);
      expect(next.reps).toBe(1);
      expect(next.lapses).toBe(0);
      expect(next.lastReviewedAt).toBe(now.toISOString());
      expect(new Date(next.due).getTime()).toBe(now.getTime() + dueDeltaMs);
      // Due always moves strictly into the future.
      expect(new Date(next.due).getTime()).toBeGreaterThan(now.getTime());
    }
  );

  it("graduates a new card to long-term review on Easy with a multi-day interval", () => {
    const next = applyRating(newReviewState(now), "easy", now, deterministic);
    expect(next.state).toBe("review");
    expect(next.scheduledDays).toBe(8);
    expect(next.stability).toBeGreaterThan(0);
  });
});

describe("applyRating on a graduated card", () => {
  // A review-state card: Easy from new graduates straight to "review".
  function reviewCard(): ReviewState {
    return applyRating(newReviewState(now), "easy", now, deterministic);
  }

  it("counts a lapse and drops to relearning when a review card is rated Again", () => {
    const review = reviewCard();
    const lapsed = applyRating(review, "again", new Date(review.due), deterministic);
    expect(review.state).toBe("review");
    expect(review.lapses).toBe(0);
    expect(lapsed.state).toBe("relearning");
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.reps).toBe(review.reps + 1);
  });

  it("keeps growing the interval on a successful Good review", () => {
    const review = reviewCard();
    const next = applyRating(review, "good", new Date(review.due), deterministic);
    expect(next.state).toBe("review");
    expect(next.lapses).toBe(0);
    expect(next.reps).toBe(review.reps + 1);
    expect(next.scheduledDays).toBeGreaterThan(review.scheduledDays);
  });
});

describe("isDue", () => {
  it("is true for a brand-new card at `now` (due immediately)", () => {
    expect(isDue(newReviewState(now), now)).toBe(true);
  });

  it("is false before due and true at/after the due instant (boundary at due)", () => {
    const scheduled = applyRating(newReviewState(now), "easy", now, deterministic);
    const due = new Date(scheduled.due);
    expect(isDue(scheduled, new Date(due.getTime() - 1))).toBe(false);
    expect(isDue(scheduled, due)).toBe(true);
    expect(isDue(scheduled, new Date(due.getTime() + 1))).toBe(true);
  });
});

describe("retrievability", () => {
  it("is a probability that decreases as time passes since review", () => {
    const scheduled = applyRating(newReviewState(now), "easy", now, deterministic);
    const near = retrievability(scheduled, new Date(scheduled.due));
    const far = retrievability(scheduled, new Date(new Date(scheduled.due).getTime() + 30 * day));
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThanOrEqual(1);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(1);
  });
});

describe("determinism and immutability", () => {
  it("is deterministic when fuzz is disabled", () => {
    const first = applyRating(newReviewState(now), "good", now, deterministic);
    const second = applyRating(newReviewState(now), "good", now, deterministic);
    expect(first).toEqual(second);
  });

  it("does not mutate the input state and returns a frozen result", () => {
    const input = newReviewState(now);
    const snapshot = { ...input };
    const next = applyRating(input, "good", now, deterministic);
    expect(input).toEqual(snapshot);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(newReviewState(now))).toBe(true);
  });
});
