import { describe, expect, it } from "vitest";

import { blockRangesOverlap, type BlockRange } from "./noteOverlap";

const range = (blockEntryId: string, startOffset: number, endOffset: number): BlockRange => ({
  blockEntryId,
  endOffset,
  startOffset
});

describe("blockRangesOverlap", () => {
  it("is false when either set is empty", () => {
    expect(blockRangesOverlap([], [range("b1", 0, 5)])).toBe(false);
    expect(blockRangesOverlap([range("b1", 0, 5)], [])).toBe(false);
  });

  it("is false for ranges in different blocks even at the same offsets", () => {
    expect(blockRangesOverlap([range("b1", 0, 5)], [range("b2", 0, 5)])).toBe(false);
  });

  it("is false for two disjoint ranges in one block that merely touch end-to-start", () => {
    // [0,5) and [5,10) share no character (half-open intervals).
    expect(blockRangesOverlap([range("b1", 0, 5)], [range("b1", 5, 10)])).toBe(false);
  });

  it("is true when ranges in the same block share a character", () => {
    expect(blockRangesOverlap([range("b1", 2, 6)], [range("b1", 5, 10)])).toBe(true);
  });

  it("detects overlap on a shared block within multi-block spans", () => {
    // A span over b1+b2 vs a span over b2+b3 overlap on b2.
    const spanA = [range("b1", 4, 9), range("b2", 0, 3)];
    const spanB = [range("b2", 2, 7), range("b3", 0, 5)];
    expect(blockRangesOverlap(spanA, spanB)).toBe(true);
  });

  it("is false when multi-block spans share a block but not a character", () => {
    const spanA = [range("b1", 0, 4), range("b2", 0, 2)];
    const spanB = [range("b2", 2, 7), range("b3", 0, 5)];
    expect(blockRangesOverlap(spanA, spanB)).toBe(false);
  });
});
