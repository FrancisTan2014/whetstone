import { describe, expect, it } from "vitest";

import type { NoteDraft } from "../notes/noteCapture";
import { deriveExplainEligibility } from "./explainTarget";

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    blockEntryId: "b1",
    contextSnapshot: "The bank was busy today.",
    selectedText: "bank",
    startOffset: 4,
    endOffset: 8,
    ...overrides
  };
}

// A whole-single-block capture never carries `startOffset`/`endOffset` at all (they are omitted, not
// set to `undefined` — the repo's `exactOptionalPropertyTypes` distinguishes the two).
function wholeBlockDraft(
  overrides: Partial<Omit<NoteDraft, "endOffset" | "startOffset">> = {}
): NoteDraft {
  return {
    blockEntryId: "b1",
    contextSnapshot: "The bank was busy today.",
    selectedText: "bank",
    ...overrides
  };
}

describe("deriveExplainEligibility", () => {
  it("is eligible with an exact-range request from a sub-block selection", () => {
    expect(deriveExplainEligibility("w1", draft())).toEqual({
      status: "eligible",
      target: {
        blockEntryId: "b1",
        endOffset: 8,
        selectedText: "bank",
        startOffset: 4,
        workEntryId: "w1"
      }
    });
  });

  it("reconstructs 0..length offsets for a whole-single-block capture (no offsets on the draft)", () => {
    const wholeBlock = wholeBlockDraft({ selectedText: "bank" });
    expect(deriveExplainEligibility("w1", wholeBlock)).toEqual({
      status: "eligible",
      target: {
        blockEntryId: "b1",
        endOffset: 4,
        selectedText: "bank",
        startOffset: 0,
        workEntryId: "w1"
      }
    });
  });

  it("is cross_block for a cross-block span (the contract is single-block only), never a silent omission", () => {
    expect(deriveExplainEligibility("w1", draft({ endBlockEntryId: "b2" }))).toEqual({
      status: "cross_block"
    });
  });

  it("is eligible when endBlockEntryId merely repeats the same block", () => {
    expect(deriveExplainEligibility("w1", draft({ endBlockEntryId: "b1" })).status).toBe(
      "eligible"
    );
  });

  it("is none for a whitespace-only selection", () => {
    expect(deriveExplainEligibility("w1", wholeBlockDraft({ selectedText: "   " }))).toEqual({
      status: "none"
    });
  });

  // #925 correction: the server's own 300-code-unit cap (`explainContracts.ts`) is authoritative, so a
  // selection well over it is still `eligible` here — never a duplicated, drifting client-only gate
  // that silently removes the action. The real backend surfaces its own invalid-request guidance on
  // explicit invocation instead.
  it("stays eligible for a selection well over the server's 300-code-unit cap", () => {
    const overLong = "x".repeat(500);
    expect(deriveExplainEligibility("w1", wholeBlockDraft({ selectedText: overLong }))).toEqual({
      status: "eligible",
      target: {
        blockEntryId: "b1",
        endOffset: 500,
        selectedText: overLong,
        startOffset: 0,
        workEntryId: "w1"
      }
    });
  });

  it("is eligible at exactly the server's 300-code-unit cap", () => {
    const atCap = "x".repeat(300);
    expect(deriveExplainEligibility("w1", wholeBlockDraft({ selectedText: atCap }))).toEqual({
      status: "eligible",
      target: {
        blockEntryId: "b1",
        endOffset: 300,
        selectedText: atCap,
        startOffset: 0,
        workEntryId: "w1"
      }
    });
  });
});
