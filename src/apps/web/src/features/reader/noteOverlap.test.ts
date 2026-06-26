import { describe, expect, it } from "vitest";

import { selectionOverlapsNote } from "./noteOverlap";

describe("selectionOverlapsNote", () => {
  it("is false when the block has no notes", () => {
    expect(selectionOverlapsNote([], { endOffset: 5, startOffset: 0 })).toBe(false);
  });

  it("is false for two disjoint sub-block ranges that merely touch end-to-start", () => {
    // [0,5) and [5,10) share no character (half-open intervals).
    expect(
      selectionOverlapsNote([{ endOffset: 5, startOffset: 0 }], { endOffset: 10, startOffset: 5 })
    ).toBe(false);
  });

  it("is true when sub-block ranges share a character", () => {
    expect(
      selectionOverlapsNote([{ endOffset: 6, startOffset: 2 }], { endOffset: 10, startOffset: 5 })
    ).toBe(true);
  });

  it("treats an existing whole-block note as covering the entire block", () => {
    expect(selectionOverlapsNote([{}], { endOffset: 3, startOffset: 1 })).toBe(true);
  });

  it("treats a whole-block selection as overlapping any existing note", () => {
    expect(selectionOverlapsNote([{ endOffset: 3, startOffset: 1 }], {})).toBe(true);
  });

  it("detects overlap against any one of several existing notes", () => {
    const existing = [
      { endOffset: 4, startOffset: 0 },
      { endOffset: 20, startOffset: 12 }
    ];
    expect(selectionOverlapsNote(existing, { endOffset: 15, startOffset: 13 })).toBe(true);
    expect(selectionOverlapsNote(existing, { endOffset: 12, startOffset: 8 })).toBe(false);
  });
});
