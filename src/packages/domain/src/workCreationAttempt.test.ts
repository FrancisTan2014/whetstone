import { describe, expect, it } from "vitest";

import {
  canBeginFinalize,
  canCancelWorkCreationAttempt,
  canCompleteFinalize,
  canTransferStage,
  fingerprintReviewedCandidates,
  isActiveWorkCreationAttemptState,
  isTerminalWorkCreationAttemptState,
  ownsOrdinaryUploadStage,
  workCreationAttemptStates,
  workCreationSourceKinds,
  type ReviewedCandidateSnapshot,
  type WorkCreationAttemptState
} from "./workCreationAttempt.js";

const candidate = (over: Partial<ReviewedCandidateSnapshot[number]> = {}) => ({
  entryId: "work-1",
  title: "Designing Data-Intensive Applications",
  authorId: "author-1",
  authorName: "Martin Kleppmann",
  language: "en",
  workType: "book",
  ...over
});

describe("workCreationAttempt states", () => {
  it("classifies exactly completed/cancelled/expired as terminal", () => {
    const terminal = workCreationAttemptStates.filter(isTerminalWorkCreationAttemptState);
    expect([...terminal].sort()).toEqual(["cancelled", "completed", "expired"]);
  });

  it("treats active as the complement of terminal", () => {
    for (const state of workCreationAttemptStates) {
      expect(isActiveWorkCreationAttemptState(state)).toBe(
        !isTerminalWorkCreationAttemptState(state)
      );
    }
    const active = workCreationAttemptStates.filter(isActiveWorkCreationAttemptState);
    expect([...active].sort()).toEqual(["finalizing", "pending"]);
  });

  it("permits begin-finalize only from pending and complete only from finalizing", () => {
    const beginFrom = workCreationAttemptStates.filter(canBeginFinalize);
    const completeFrom = workCreationAttemptStates.filter(canCompleteFinalize);
    expect(beginFrom).toEqual(["pending"]);
    expect(completeFrom).toEqual(["finalizing"]);
  });

  it("permits transferring a stage only from finalizing (inside the serialized decision)", () => {
    const transferFrom = workCreationAttemptStates.filter(canTransferStage);
    expect(transferFrom).toEqual(["finalizing"]);
  });

  it("permits Back/cancel only from pending, never from finalizing or a terminal state", () => {
    const cancelFrom = workCreationAttemptStates.filter(canCancelWorkCreationAttempt);
    expect(cancelFrom).toEqual(["pending"]);
    // A finalizing attempt holds a live committer, so it is active yet NOT cancellable — cancel is a
    // strict subset of active, so the two predicates must diverge exactly on `finalizing`.
    expect(canCancelWorkCreationAttempt("finalizing")).toBe(false);
    expect(isActiveWorkCreationAttemptState("finalizing")).toBe(true);
  });
});

describe("ownsOrdinaryUploadStage", () => {
  it("is true only for the ordinary upload kinds", () => {
    const owning = workCreationSourceKinds.filter(ownsOrdinaryUploadStage);
    expect([...owning].sort()).toEqual(["epub", "markdown"]);
    expect(ownsOrdinaryUploadStage("manual")).toBe(false);
    expect(ownsOrdinaryUploadStage("pdf")).toBe(false);
  });
});

describe("fingerprintReviewedCandidates", () => {
  it("is independent of candidate scoring/display order", () => {
    const a = [candidate({ entryId: "w1" }), candidate({ entryId: "w2" })];
    const b = [candidate({ entryId: "w2" }), candidate({ entryId: "w1" })];
    expect(fingerprintReviewedCandidates(a)).toBe(fingerprintReviewedCandidates(b));
  });

  it("changes when any displayed field changes, not only the candidate id", () => {
    const base = [candidate()];
    const fp = fingerprintReviewedCandidates(base);
    expect(fingerprintReviewedCandidates([candidate({ title: "Different" })])).not.toBe(fp);
    expect(fingerprintReviewedCandidates([candidate({ authorName: "Someone Else" })])).not.toBe(fp);
    expect(fingerprintReviewedCandidates([candidate({ authorId: "author-2" })])).not.toBe(fp);
    expect(fingerprintReviewedCandidates([candidate({ language: "zh-CN" })])).not.toBe(fp);
    expect(fingerprintReviewedCandidates([candidate({ workType: "essay" })])).not.toBe(fp);
  });

  it("gives the empty snapshot a stable fingerprint distinct from any non-empty one", () => {
    expect(fingerprintReviewedCandidates([])).toBe(fingerprintReviewedCandidates([]));
    expect(fingerprintReviewedCandidates([])).not.toBe(
      fingerprintReviewedCandidates([candidate()])
    );
  });

  it("cannot be collided by smuggling a separator into a field value", () => {
    const withSeparator = fingerprintReviewedCandidates([candidate({ title: "A\u001fB" })]);
    const twoFields = fingerprintReviewedCandidates([candidate({ title: "A", authorId: "B" })]);
    expect(withSeparator).not.toBe(twoFields);

    const withRowSeparator = fingerprintReviewedCandidates([candidate({ title: "X\u001eY" })]);
    expect(withRowSeparator).not.toBe(fingerprintReviewedCandidates([candidate({ title: "XY" })]));

    const withBackslash = fingerprintReviewedCandidates([candidate({ title: "A\\u" })]);
    expect(withBackslash).not.toBe(
      fingerprintReviewedCandidates([candidate({ title: "A\u001f" })])
    );
  });
});

// A compile-time guard that the exported union stays exhaustive for the store's fencing.
const _exhaustive: readonly WorkCreationAttemptState[] = workCreationAttemptStates;
void _exhaustive;
