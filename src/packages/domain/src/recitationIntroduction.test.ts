import { describe, expect, it } from "vitest";

import {
  evaluateRecitationIntroduction,
  RECITATION_DAILY_INTRODUCTION_CAP
} from "./recitationIntroduction.js";

// A fully-available baseline (learning, nothing due, no introductions yet, a passage queued); each test
// perturbs one dimension to prove exactly one reason wins.
const available = {
  dueCount: 0,
  hasQueued: true,
  introducedToday: 0,
  isLearning: true
} as const;

describe("evaluateRecitationIntroduction", () => {
  it("offers a new passage when learning, nothing due, under the cap, with a queued passage", () => {
    const result = evaluateRecitationIntroduction(available);

    expect(result).toEqual({
      dailyCap: RECITATION_DAILY_INTRODUCTION_CAP,
      newPassageAvailable: true,
      reason: "available",
      remainingCapacity: 3
    });
  });

  it("reports remaining capacity shrinking as passages are introduced today", () => {
    expect(
      evaluateRecitationIntroduction({ ...available, introducedToday: 1 }).remainingCapacity
    ).toBe(2);
    expect(
      evaluateRecitationIntroduction({ ...available, introducedToday: 2 }).remainingCapacity
    ).toBe(1);
  });

  it("blocks with not_learning when the plan is not in the learning phase, taking precedence over all else", () => {
    const result = evaluateRecitationIntroduction({
      dueCount: 5,
      hasQueued: false,
      introducedToday: 3,
      isLearning: false
    });

    expect(result.reason).toBe("not_learning");
    expect(result.newPassageAvailable).toBe(false);
  });

  it("blocks with due_work_remains when an introduced passage is due, before the cap or queue checks", () => {
    const result = evaluateRecitationIntroduction({
      dueCount: 1,
      hasQueued: false,
      introducedToday: 3,
      isLearning: true
    });

    expect(result.reason).toBe("due_work_remains");
    expect(result.newPassageAvailable).toBe(false);
  });

  it("blocks with all_introduced when no queued passage remains, before the cap check", () => {
    const result = evaluateRecitationIntroduction({
      dueCount: 0,
      hasQueued: false,
      introducedToday: 3,
      isLearning: true
    });

    expect(result.reason).toBe("all_introduced");
    expect(result.newPassageAvailable).toBe(false);
  });

  it("blocks with cap_reached when the daily cap is met and a queued passage remains", () => {
    const result = evaluateRecitationIntroduction({
      dueCount: 0,
      hasQueued: true,
      introducedToday: RECITATION_DAILY_INTRODUCTION_CAP,
      isLearning: true
    });

    expect(result.reason).toBe("cap_reached");
    expect(result.newPassageAvailable).toBe(false);
    expect(result.remainingCapacity).toBe(0);
  });

  it("clamps remaining capacity to zero if more than the cap were somehow introduced", () => {
    const result = evaluateRecitationIntroduction({
      ...available,
      hasQueued: true,
      introducedToday: RECITATION_DAILY_INTRODUCTION_CAP + 2
    });

    expect(result.remainingCapacity).toBe(0);
    expect(result.reason).toBe("cap_reached");
  });
});
