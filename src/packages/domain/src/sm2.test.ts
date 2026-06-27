import { describe, expect, it } from "vitest";

import {
  gradeFromRating,
  newReviewState,
  scheduleReview,
  type ReviewGrade,
  type ReviewRating,
  type ReviewState
} from "./sm2.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const dayMs = 24 * 60 * 60 * 1000;
const isoAfter = (days: number): string => new Date(now.getTime() + days * dayMs).toISOString();

// Review the item with the given grades in order, starting from a fresh item.
function reviewSequence(grades: ReadonlyArray<ReviewGrade>): ReviewState {
  return grades.reduce<ReviewState>(
    (state, grade) => scheduleReview(state, grade, now),
    newReviewState(now)
  );
}

describe("newReviewState", () => {
  it("starts at the default ease, no history, due immediately", () => {
    expect(newReviewState(now)).toEqual({
      easeFactor: 2.5,
      intervalDays: 0,
      repetitions: 0,
      lapses: 0,
      lastReviewedAt: null,
      dueAt: now.toISOString()
    });
  });

  it("returns a frozen state that cannot be mutated", () => {
    const state = newReviewState(now);

    expect(Object.isFrozen(state)).toBe(true);
    expect(() => {
      (state as { easeFactor: number }).easeFactor = 9;
    }).toThrow();
  });
});

describe("gradeFromRating", () => {
  const cases: ReadonlyArray<readonly [ReviewRating, ReviewGrade]> = [
    ["again", 0],
    ["hard", 3],
    ["good", 4],
    ["easy", 5]
  ];

  it.each(cases)("maps %s onto the SM-2 quality scale", (rating, grade) => {
    expect(gradeFromRating(rating)).toBe(grade);
  });
});

describe("scheduleReview — successful progression", () => {
  it("grows the interval 1d -> 6d -> x ease on consecutive good grades", () => {
    const first = scheduleReview(newReviewState(now), gradeFromRating("good"), now);
    expect(first).toMatchObject({ intervalDays: 1, repetitions: 1, lapses: 0, easeFactor: 2.5 });
    expect(first.dueAt).toBe(isoAfter(1));
    expect(first.lastReviewedAt).toBe(now.toISOString());

    const second = scheduleReview(first, gradeFromRating("good"), now);
    expect(second).toMatchObject({ intervalDays: 6, repetitions: 2, easeFactor: 2.5 });
    expect(second.dueAt).toBe(isoAfter(6));

    // Third+ review multiplies the previous interval by the ease (good keeps ease at 2.5).
    const third = scheduleReview(second, gradeFromRating("good"), now);
    expect(third).toMatchObject({ intervalDays: 15, repetitions: 3, easeFactor: 2.5 });
    expect(third.dueAt).toBe(isoAfter(15));
  });

  it("raises ease on easy and lowers it (but still passes) on hard", () => {
    const easy = scheduleReview(newReviewState(now), gradeFromRating("easy"), now);
    expect(easy.easeFactor).toBeCloseTo(2.6, 10);
    expect(easy.repetitions).toBe(1);

    const hard = scheduleReview(newReviewState(now), gradeFromRating("hard"), now);
    expect(hard.easeFactor).toBeCloseTo(2.36, 10);
    expect(hard.repetitions).toBe(1);
    expect(hard.lapses).toBe(0);
  });
});

describe("scheduleReview — lapses", () => {
  it("resets repetitions and interval, counts the lapse, and lowers ease", () => {
    const mature = reviewSequence([4, 4, 4]); // interval 15, reps 3, ease 2.5, lapses 0
    expect(mature).toMatchObject({ intervalDays: 15, repetitions: 3, lapses: 0 });

    const lapsed = scheduleReview(mature, gradeFromRating("again"), now);
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.intervalDays).toBe(1);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.easeFactor).toBeLessThan(mature.easeFactor);
    expect(lapsed.dueAt).toBe(isoAfter(1));
  });

  it.each([0, 1, 2] as const)(
    "treats grade %i as a lapse (below the passing threshold)",
    (grade) => {
      const result = scheduleReview(reviewSequence([4, 4]), grade, now);
      expect(result.repetitions).toBe(0);
      expect(result.intervalDays).toBe(1);
      expect(result.lapses).toBe(1);
    }
  );
});

describe("scheduleReview — ease floor", () => {
  it("never lets the ease factor fall below 1.3, however many failures", () => {
    let state = newReviewState(now);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      state = scheduleReview(state, 0, now);
      expect(state.easeFactor).toBeGreaterThanOrEqual(1.3);
    }
    expect(state.easeFactor).toBe(1.3);
  });
});

describe("scheduleReview — purity and validation", () => {
  it("returns a frozen state and does not mutate the input", () => {
    const before = reviewSequence([4, 4]);
    const snapshot = { ...before };

    const after = scheduleReview(before, gradeFromRating("good"), now);

    expect(Object.isFrozen(after)).toBe(true);
    expect(before).toEqual(snapshot); // input untouched
  });

  it("is deterministic for the same (state, grade, now)", () => {
    const state = reviewSequence([4]);
    expect(scheduleReview(state, 4, now)).toEqual(scheduleReview(state, 4, now));
  });

  it.each([-1, 6, 2.5, Number.NaN])("rejects an out-of-range or non-integer grade %s", (grade) => {
    expect(() => scheduleReview(newReviewState(now), grade as ReviewGrade, now)).toThrow(
      /grade must be an integer between 0 and 5/u
    );
  });
});
