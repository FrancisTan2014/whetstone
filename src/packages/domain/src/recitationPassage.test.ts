import { describe, expect, it } from "vitest";

import {
  coveredPassageText,
  isRecitationCueStrength,
  mergePassageRanges,
  OPENING_CUE_CHARS,
  passageAnchorStatuses,
  passageCueText,
  PRECEDING_LINE_MAX_CHARS,
  reanchorPassageRange,
  recitationCueStrengths,
  recitationRatingChoices,
  seedPassageRanges,
  splitPassageRange,
  type PassageBlock,
  type PassageRange
} from "./index.js";

const blocks: PassageBlock[] = [
  { blockEntryId: "b1", text: "Alpha beta" },
  { blockEntryId: "b2", text: "Gamma delta" },
  { blockEntryId: "b3", text: "Epsilon" }
];

function textMap(source: readonly PassageBlock[]): Map<string, string> {
  return new Map(source.map((block) => [block.blockEntryId, block.text] as const));
}

describe("recitation cue strengths", () => {
  it("orders cues weakest-context to strongest-nudge", () => {
    expect(recitationCueStrengths).toEqual(["preceding_line", "opening"]);
  });

  it("recognizes only the real cue strengths", () => {
    for (const strength of recitationCueStrengths) {
      expect(isRecitationCueStrength(strength)).toBe(true);
    }
    expect(isRecitationCueStrength("full")).toBe(false);
    expect(isRecitationCueStrength("")).toBe(false);
    expect(isRecitationCueStrength(undefined)).toBe(false);
  });
});

describe("passageCueText", () => {
  it("reveals only the target's opening characters for the opening cue", () => {
    expect(passageCueText("opening", "Clean and natural recitation", "ignored")).toBe(
      "Clean ".slice(0, OPENING_CUE_CHARS)
    );
    expect(passageCueText("opening", "Clean and natural recitation", null)).toHaveLength(
      OPENING_CUE_CHARS
    );
  });

  it("shows the preceding passage's final line, capped to a restrained tail", () => {
    expect(passageCueText("preceding_line", "target", "first line\nthe closing line")).toBe(
      "the closing line"
    );
    const longTail = "x".repeat(PRECEDING_LINE_MAX_CHARS + 10);
    expect(passageCueText("preceding_line", "target", longTail)).toBe(
      "x".repeat(PRECEDING_LINE_MAX_CHARS)
    );
  });

  it("has no preceding-line cue for the first passage", () => {
    expect(passageCueText("preceding_line", "target", null)).toBe("");
  });
});

describe("recitationRatingChoices", () => {
  it("maps each self-assessment onto its FSRS rating in order", () => {
    expect(recitationRatingChoices).toEqual([
      { label: "Couldn't continue", rating: "again" },
      { label: "Needed cues", rating: "hard" },
      { label: "Complete, with effort", rating: "good" },
      { label: "Clean and natural", rating: "easy" }
    ]);
  });
});

describe("passageAnchorStatuses", () => {
  it("names the anchored and needs-repair states", () => {
    expect(passageAnchorStatuses).toEqual(["anchored", "needs_repair"]);
  });
});

describe("seedPassageRanges", () => {
  it("seeds one full-block passage per non-empty block in source order", () => {
    expect(seedPassageRanges(blocks)).toEqual([
      { endBlockEntryId: "b1", endOffset: 10, startBlockEntryId: "b1", startOffset: 0 },
      { endBlockEntryId: "b2", endOffset: 11, startBlockEntryId: "b2", startOffset: 0 },
      { endBlockEntryId: "b3", endOffset: 7, startBlockEntryId: "b3", startOffset: 0 }
    ]);
  });

  it("skips blank blocks", () => {
    const seeded = seedPassageRanges([
      { blockEntryId: "h", text: "   " },
      { blockEntryId: "p", text: "content" }
    ]);
    expect(seeded).toEqual([
      { endBlockEntryId: "p", endOffset: 7, startBlockEntryId: "p", startOffset: 0 }
    ]);
  });
});

describe("coveredPassageText", () => {
  it("slices a single-block range", () => {
    expect(
      coveredPassageText(
        { endBlockEntryId: "b1", endOffset: 5, startBlockEntryId: "b1", startOffset: 0 },
        textMap(blocks)
      )
    ).toBe("Alpha");
  });

  it("joins a multi-block range with a newline", () => {
    expect(
      coveredPassageText(
        { endBlockEntryId: "b2", endOffset: 5, startBlockEntryId: "b1", startOffset: 6 },
        textMap(blocks)
      )
    ).toBe("beta\nGamma");
  });

  it("returns null when a referenced block is gone", () => {
    expect(
      coveredPassageText(
        { endBlockEntryId: "b1", endOffset: 5, startBlockEntryId: "gone", startOffset: 0 },
        textMap(blocks)
      )
    ).toBeNull();
    expect(
      coveredPassageText(
        { endBlockEntryId: "gone", endOffset: 5, startBlockEntryId: "b1", startOffset: 0 },
        textMap(blocks)
      )
    ).toBeNull();
  });
});

describe("splitPassageRange", () => {
  const full: PassageRange = {
    endBlockEntryId: "b1",
    endOffset: 10,
    startBlockEntryId: "b1",
    startOffset: 0
  };

  it("splits a single-block passage into two contiguous halves", () => {
    const result = splitPassageRange(blocks, full, { blockEntryId: "b1", offset: 5 });
    expect(result).toEqual({
      first: { endBlockEntryId: "b1", endOffset: 5, startBlockEntryId: "b1", startOffset: 0 },
      second: { endBlockEntryId: "b1", endOffset: 10, startBlockEntryId: "b1", startOffset: 5 },
      status: "split"
    });
  });

  it("splits a multi-block passage at a middle block", () => {
    const merged: PassageRange = {
      endBlockEntryId: "b3",
      endOffset: 7,
      startBlockEntryId: "b1",
      startOffset: 0
    };
    const result = splitPassageRange(blocks, merged, { blockEntryId: "b2", offset: 5 });
    expect(result).toEqual({
      first: { endBlockEntryId: "b2", endOffset: 5, startBlockEntryId: "b1", startOffset: 0 },
      second: { endBlockEntryId: "b3", endOffset: 7, startBlockEntryId: "b2", startOffset: 5 },
      status: "split"
    });
  });

  it("rejects a split point in an unknown block", () => {
    expect(splitPassageRange(blocks, full, { blockEntryId: "ghost", offset: 1 })).toEqual({
      reason: "unknown_block",
      status: "invalid"
    });
  });

  it("rejects a split when the passage references an unknown block", () => {
    const stray: PassageRange = {
      endBlockEntryId: "ghost",
      endOffset: 1,
      startBlockEntryId: "b1",
      startOffset: 0
    };
    expect(splitPassageRange(blocks, stray, { blockEntryId: "b1", offset: 5 })).toEqual({
      reason: "unknown_block",
      status: "invalid"
    });
  });

  it("rejects an offset outside the block", () => {
    expect(splitPassageRange(blocks, full, { blockEntryId: "b1", offset: -1 })).toEqual({
      reason: "out_of_range",
      status: "invalid"
    });
    expect(splitPassageRange(blocks, full, { blockEntryId: "b1", offset: 11 })).toEqual({
      reason: "out_of_range",
      status: "invalid"
    });
  });

  it("rejects a split on either boundary of the passage", () => {
    expect(splitPassageRange(blocks, full, { blockEntryId: "b1", offset: 0 })).toEqual({
      reason: "at_boundary",
      status: "invalid"
    });
    expect(splitPassageRange(blocks, full, { blockEntryId: "b1", offset: 10 })).toEqual({
      reason: "at_boundary",
      status: "invalid"
    });
  });

  it("rejects a split before the start or after the end of a mid-work passage", () => {
    const middle: PassageRange = {
      endBlockEntryId: "b2",
      endOffset: 6,
      startBlockEntryId: "b2",
      startOffset: 2
    };
    expect(splitPassageRange(blocks, middle, { blockEntryId: "b1", offset: 3 })).toEqual({
      reason: "at_boundary",
      status: "invalid"
    });
    expect(splitPassageRange(blocks, middle, { blockEntryId: "b2", offset: 1 })).toEqual({
      reason: "at_boundary",
      status: "invalid"
    });
    expect(splitPassageRange(blocks, middle, { blockEntryId: "b3", offset: 1 })).toEqual({
      reason: "at_boundary",
      status: "invalid"
    });
  });
});

describe("mergePassageRanges", () => {
  it("merges two order-consecutive passages that meet inside a block", () => {
    const result = mergePassageRanges(
      { endBlockEntryId: "b1", endOffset: 5, startBlockEntryId: "b1", startOffset: 0 },
      { endBlockEntryId: "b2", endOffset: 11, startBlockEntryId: "b1", startOffset: 5 }
    );
    expect(result).toEqual({
      range: { endBlockEntryId: "b2", endOffset: 11, startBlockEntryId: "b1", startOffset: 0 }
    });
  });

  it("merges whole-block passages across a block boundary (offsets need not meet)", () => {
    const result = mergePassageRanges(
      { endBlockEntryId: "b1", endOffset: 20, startBlockEntryId: "b1", startOffset: 0 },
      { endBlockEntryId: "b3", endOffset: 24, startBlockEntryId: "b3", startOffset: 0 }
    );
    expect(result).toEqual({
      range: { endBlockEntryId: "b3", endOffset: 24, startBlockEntryId: "b1", startOffset: 0 }
    });
  });
});

describe("reanchorPassageRange", () => {
  const single: PassageRange = {
    endBlockEntryId: "b1",
    endOffset: 5,
    startBlockEntryId: "b1",
    startOffset: 0
  };

  it("is unchanged when the source text still matches", () => {
    expect(reanchorPassageRange({ range: single, sourceText: "Alpha" }, textMap(blocks))).toEqual({
      status: "unchanged"
    });
  });

  it("relocates a single-block passage when the text moved", () => {
    const edited = new Map([["b1", "New prefix Alpha beta"]]);
    expect(reanchorPassageRange({ range: single, sourceText: "Alpha" }, edited)).toEqual({
      range: { endBlockEntryId: "b1", endOffset: 16, startBlockEntryId: "b1", startOffset: 11 },
      status: "relocated"
    });
  });

  it("needs repair when the source text is gone", () => {
    const edited = new Map([["b1", "totally different"]]);
    expect(reanchorPassageRange({ range: single, sourceText: "Alpha" }, edited)).toEqual({
      status: "needs_repair"
    });
  });

  it("needs repair when the block was deleted", () => {
    expect(reanchorPassageRange({ range: single, sourceText: "Alpha" }, new Map())).toEqual({
      status: "needs_repair"
    });
  });

  it("needs repair when a multi-block passage drifts", () => {
    const multi: PassageRange = {
      endBlockEntryId: "b2",
      endOffset: 5,
      startBlockEntryId: "b1",
      startOffset: 6
    };
    const edited = new Map([
      ["b1", "Alpha changed"],
      ["b2", "Gamma delta"]
    ]);
    expect(reanchorPassageRange({ range: multi, sourceText: "beta\nGamma" }, edited)).toEqual({
      status: "needs_repair"
    });
  });

  it("needs repair for an empty captured source", () => {
    const edited = new Map([["b1", "Alpha beta"]]);
    expect(reanchorPassageRange({ range: single, sourceText: "" }, edited)).toEqual({
      status: "needs_repair"
    });
  });
});
