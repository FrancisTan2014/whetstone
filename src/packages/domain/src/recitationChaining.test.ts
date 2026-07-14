import { describe, expect, it } from "vitest";

import { applyRating, newReviewState, retrievability, type ReviewState } from "./fsrs.js";
import {
  chainEligibility,
  computeOwnedPrefix,
  hasValidAnchoredPassage,
  isOutcomePassageInSession,
  isPassageOwned,
  isUnstartedWholeWorkEligible,
  isWholeWorkOwned,
  MIN_CHAIN_LENGTH,
  OWNERSHIP_MIN_SUCCESSFUL_REVIEWS,
  OWNERSHIP_RETENTION_TARGET,
  passagesToFailFromOutcome,
  recitationTodayActions,
  resolveChainBoundary,
  selectRecitationTodayAction,
  type PassageMastery,
  type SessionRecallOutcome
} from "./recitationChaining.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_FUZZ = { enableFuzz: false } as const;

// A well-practised passage's FSRS state: two clean Good recalls a day apart, evaluated `at`. Right after
// the second review retrievability is ~1; letting `at` run far past the due date lets a test drive it
// below the retention target to prove ownership lapses with memory.
function reviewedTwice(t0: Date): ReviewState {
  const first = applyRating(newReviewState(t0), "good", t0, NO_FUZZ);
  return applyRating(first, "good", new Date(t0.getTime() + DAY_MS), NO_FUZZ);
}

// A passage-mastery fixture with the given successful-review count and a state reviewed twice at `t0`.
function ownedMastery(id: string, t0: Date, successfulReviews = 2): PassageMastery {
  return { anchored: true, passageEntryId: id, state: reviewedTwice(t0), successfulReviews };
}

// A queued passage: introduced but never activated, so it has no FSRS card and no reviews (#605).
function queuedMastery(id: string, anchored = true): PassageMastery {
  return { anchored, passageEntryId: id, state: null, successfulReviews: 0 };
}

const T0 = new Date("2026-01-01T00:00:00.000Z");
// Just after the second review: retrievability ~1, so a twice-reviewed passage is owned.
const JUST_AFTER = new Date(T0.getTime() + DAY_MS + 60 * 1000);

describe("isPassageOwned", () => {
  it("owns a passage with two successful reviews still above the retention target", () => {
    const passage = ownedMastery("p1", T0);
    expect(retrievability(passage.state, JUST_AFTER)).toBeGreaterThanOrEqual(
      OWNERSHIP_RETENTION_TARGET
    );
    expect(isPassageOwned(passage, JUST_AFTER)).toBe(true);
  });

  it("does not own a passage with only one successful review, however fresh", () => {
    const passage: PassageMastery = { ...ownedMastery("p1", T0), successfulReviews: 1 };
    expect(isPassageOwned(passage, JUST_AFTER)).toBe(false);
  });

  it("requires exactly the configured floor of successful reviews", () => {
    expect(OWNERSHIP_MIN_SUCCESSFUL_REVIEWS).toBe(2);
    const atFloor = ownedMastery("p1", T0, OWNERSHIP_MIN_SUCCESSFUL_REVIEWS);
    const belowFloor = ownedMastery("p2", T0, OWNERSHIP_MIN_SUCCESSFUL_REVIEWS - 1);
    expect(isPassageOwned(atFloor, JUST_AFTER)).toBe(true);
    expect(isPassageOwned(belowFloor, JUST_AFTER)).toBe(false);
  });

  it("loses ownership once retrievability decays below the target, despite enough reviews", () => {
    const passage = ownedMastery("p1", T0);
    // Far in the future the card is well past due; retrievability falls under the target.
    const faded = new Date(T0.getTime() + 400 * DAY_MS);
    expect(retrievability(passage.state!, faded)).toBeLessThan(OWNERSHIP_RETENTION_TARGET);
    expect(isPassageOwned(passage, faded)).toBe(false);
  });

  it("never owns a queued passage, which has no schedule or reviews", () => {
    expect(isPassageOwned(queuedMastery("p1"), JUST_AFTER)).toBe(false);
  });
});

describe("computeOwnedPrefix", () => {
  it("counts owned passages contiguously from the beginning and stops at the first gap", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p3", T0), successfulReviews: 0 };
    const passages = [
      ownedMastery("p1", T0),
      ownedMastery("p2", T0),
      notOwned,
      ownedMastery("p4", T0)
    ];
    // p4 is owned but disconnected — it must not count.
    expect(computeOwnedPrefix(passages, JUST_AFTER)).toEqual({ ownedCount: 2, total: 4 });
  });

  it("is zero when the very first passage is not owned", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p1", T0), successfulReviews: 0 };
    const passages = [notOwned, ownedMastery("p2", T0)];
    expect(computeOwnedPrefix(passages, JUST_AFTER)).toEqual({ ownedCount: 0, total: 2 });
  });

  it("counts every passage when all are owned", () => {
    const passages = [ownedMastery("p1", T0), ownedMastery("p2", T0), ownedMastery("p3", T0)];
    expect(computeOwnedPrefix(passages, JUST_AFTER)).toEqual({ ownedCount: 3, total: 3 });
  });

  it("reports an empty plan as zero of zero", () => {
    expect(computeOwnedPrefix([], JUST_AFTER)).toEqual({ ownedCount: 0, total: 0 });
  });
});

describe("isWholeWorkOwned", () => {
  it("is true only when every passage is owned", () => {
    const all = [ownedMastery("p1", T0), ownedMastery("p2", T0)];
    expect(isWholeWorkOwned(all, JUST_AFTER)).toBe(true);
  });

  it("is false when any passage is not yet owned", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p2", T0), successfulReviews: 0 };
    expect(isWholeWorkOwned([ownedMastery("p1", T0), notOwned], JUST_AFTER)).toBe(false);
  });

  it("is false for a plan with no passages", () => {
    expect(isWholeWorkOwned([], JUST_AFTER)).toBe(false);
  });

  it("is false when passages are only queued", () => {
    expect(isWholeWorkOwned([queuedMastery("p1"), queuedMastery("p2")], JUST_AFTER)).toBe(false);
  });
});

describe("hasValidAnchoredPassage", () => {
  it("is true when at least one passage is anchored", () => {
    expect(hasValidAnchoredPassage([queuedMastery("p1", false), queuedMastery("p2", true)])).toBe(
      true
    );
  });

  it("is false when every passage needs repair", () => {
    expect(hasValidAnchoredPassage([queuedMastery("p1", false), queuedMastery("p2", false)])).toBe(
      false
    );
  });

  it("is false for a plan with no passages", () => {
    expect(hasValidAnchoredPassage([])).toBe(false);
  });
});

describe("isUnstartedWholeWorkEligible", () => {
  it("offers maintenance upkeep as soon as one anchored passage exists, without ownership", () => {
    expect(isUnstartedWholeWorkEligible("maintenance", [queuedMastery("p1")], JUST_AFTER)).toBe(
      true
    );
  });

  it("does not offer maintenance upkeep when the only passage needs repair", () => {
    expect(
      isUnstartedWholeWorkEligible("maintenance", [queuedMastery("p1", false)], JUST_AFTER)
    ).toBe(false);
  });

  it("requires full ownership for a learning plan, not mere anchoring", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p2", T0), successfulReviews: 0 };
    expect(
      isUnstartedWholeWorkEligible("learning", [ownedMastery("p1", T0), notOwned], JUST_AFTER)
    ).toBe(false);
    expect(
      isUnstartedWholeWorkEligible(
        "learning",
        [ownedMastery("p1", T0), ownedMastery("p2", T0)],
        JUST_AFTER
      )
    ).toBe(true);
  });

  it("is never eligible for a familiarizing plan with no passages", () => {
    expect(isUnstartedWholeWorkEligible("familiarizing", [], JUST_AFTER)).toBe(false);
  });
});

describe("chainEligibility", () => {
  it("offers a chain once at least two contiguous passages are owned", () => {
    const passages = [ownedMastery("p1", T0), ownedMastery("p2", T0), ownedMastery("p3", T0)];
    expect(chainEligibility(passages, JUST_AFTER)).toEqual({ maxEndIndex: 2, status: "eligible" });
  });

  it("does not offer a chain with only one owned passage", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p2", T0), successfulReviews: 0 };
    expect(chainEligibility([ownedMastery("p1", T0), notOwned], JUST_AFTER)).toEqual({
      status: "not_eligible"
    });
  });

  it("caps the end boundary at the owned prefix, not the disconnected tail", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p3", T0), successfulReviews: 0 };
    const passages = [
      ownedMastery("p1", T0),
      ownedMastery("p2", T0),
      notOwned,
      ownedMastery("p4", T0)
    ];
    expect(chainEligibility(passages, JUST_AFTER)).toEqual({ maxEndIndex: 1, status: "eligible" });
  });

  it("uses the two-passage minimum constant", () => {
    expect(MIN_CHAIN_LENGTH).toBe(2);
  });
});

describe("resolveChainBoundary", () => {
  const passages = [ownedMastery("p1", T0), ownedMastery("p2", T0), ownedMastery("p3", T0)];

  it("returns the ordered ids of the contiguous run [0..endIndex]", () => {
    expect(resolveChainBoundary(passages, JUST_AFTER, 2)).toEqual({
      passageEntryIds: ["p1", "p2", "p3"],
      status: "ok"
    });
    expect(resolveChainBoundary(passages, JUST_AFTER, 1)).toEqual({
      passageEntryIds: ["p1", "p2"],
      status: "ok"
    });
  });

  it("rejects an end boundary that would make a chain shorter than two passages", () => {
    expect(resolveChainBoundary(passages, JUST_AFTER, 0)).toEqual({
      reason: "too_short",
      status: "invalid"
    });
  });

  it("rejects a non-integer boundary", () => {
    expect(resolveChainBoundary(passages, JUST_AFTER, 1.5)).toEqual({
      reason: "too_short",
      status: "invalid"
    });
  });

  it("rejects a boundary past the last passage", () => {
    expect(resolveChainBoundary(passages, JUST_AFTER, 3)).toEqual({
      reason: "out_of_range",
      status: "invalid"
    });
  });

  it("rejects a boundary reaching beyond the owned prefix", () => {
    const notOwned: PassageMastery = { ...ownedMastery("p3", T0), successfulReviews: 0 };
    const partial = [ownedMastery("p1", T0), ownedMastery("p2", T0), notOwned];
    expect(resolveChainBoundary(partial, JUST_AFTER, 2)).toEqual({
      reason: "not_owned",
      status: "invalid"
    });
  });
});

describe("selectRecitationTodayAction", () => {
  it("lists the actions in priority order ending in none", () => {
    expect(recitationTodayActions).toEqual(["due_passage", "chain", "whole_work", "none"]);
  });

  it("prefers a due passage above every other action", () => {
    expect(
      selectRecitationTodayAction({
        hasActiveChain: true,
        hasDuePassage: true,
        wholeWorkDue: true
      })
    ).toBe("due_passage");
  });

  it("prefers an active chain over whole-work when nothing is due", () => {
    expect(
      selectRecitationTodayAction({
        hasActiveChain: true,
        hasDuePassage: false,
        wholeWorkDue: true
      })
    ).toBe("chain");
  });

  it("falls to whole-work when only it is available", () => {
    expect(
      selectRecitationTodayAction({
        hasActiveChain: false,
        hasDuePassage: false,
        wholeWorkDue: true
      })
    ).toBe("whole_work");
  });

  it("is none when nothing is available", () => {
    expect(
      selectRecitationTodayAction({
        hasActiveChain: false,
        hasDuePassage: false,
        wholeWorkDue: false
      })
    ).toBe("none");
  });
});

describe("targeted lapse from a chain/whole-work outcome", () => {
  it("fails nothing when recall held throughout", () => {
    const held: SessionRecallOutcome = { status: "held" };
    expect(passagesToFailFromOutcome(held)).toEqual([]);
  });

  it("fails exactly the one identified broken passage", () => {
    const broke: SessionRecallOutcome = { passageEntryId: "p2", status: "broke" };
    expect(passagesToFailFromOutcome(broke)).toEqual(["p2"]);
  });

  it("accepts a held outcome regardless of the session set", () => {
    expect(isOutcomePassageInSession({ status: "held" }, [])).toBe(true);
  });

  it("accepts a broken passage that belongs to the session", () => {
    expect(
      isOutcomePassageInSession({ passageEntryId: "p2", status: "broke" }, ["p1", "p2", "p3"])
    ).toBe(true);
  });

  it("rejects a broken passage outside the reviewed session", () => {
    expect(isOutcomePassageInSession({ passageEntryId: "px", status: "broke" }, ["p1", "p2"])).toBe(
      false
    );
  });
});
