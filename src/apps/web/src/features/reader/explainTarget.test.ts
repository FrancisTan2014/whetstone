import { describe, expect, it } from "vitest";

import type { NoteDraft } from "../notes/noteCapture";
import { deriveExplainTarget } from "./explainTarget";

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    blockEntryId: "b1",
    contextSnapshot: "The spring rain fell softly.",
    selectedText: "spring",
    startOffset: 4,
    endOffset: 10,
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
    contextSnapshot: "The spring rain fell softly.",
    selectedText: "spring",
    ...overrides
  };
}

describe("deriveExplainTarget", () => {
  it("builds an exact-range request from a sub-block selection", () => {
    expect(deriveExplainTarget("w1", draft())).toEqual({
      blockEntryId: "b1",
      endOffset: 10,
      selectedText: "spring",
      startOffset: 4,
      workEntryId: "w1"
    });
  });

  it("reconstructs 0..length offsets for a whole-single-block capture (no offsets on the draft)", () => {
    const wholeBlock = wholeBlockDraft({ selectedText: "spring" });
    expect(deriveExplainTarget("w1", wholeBlock)).toEqual({
      blockEntryId: "b1",
      endOffset: 6,
      selectedText: "spring",
      startOffset: 0,
      workEntryId: "w1"
    });
  });

  it("is undefined for a cross-block span (the contract is single-block only)", () => {
    expect(deriveExplainTarget("w1", draft({ endBlockEntryId: "b2" }))).toBeUndefined();
  });

  it("is defined when endBlockEntryId merely repeats the same block", () => {
    expect(deriveExplainTarget("w1", draft({ endBlockEntryId: "b1" }))).toBeDefined();
  });

  it("is undefined for a whitespace-only selection", () => {
    expect(deriveExplainTarget("w1", wholeBlockDraft({ selectedText: "   " }))).toBeUndefined();
  });

  it("is undefined for a selection over the 300-code-unit cap", () => {
    const overLong = "x".repeat(301);
    expect(deriveExplainTarget("w1", wholeBlockDraft({ selectedText: overLong }))).toBeUndefined();
  });

  it("is defined at exactly the 300-code-unit cap", () => {
    const atCap = "x".repeat(300);
    expect(deriveExplainTarget("w1", wholeBlockDraft({ selectedText: atCap }))).toEqual({
      blockEntryId: "b1",
      endOffset: 300,
      selectedText: atCap,
      startOffset: 0,
      workEntryId: "w1"
    });
  });
});
