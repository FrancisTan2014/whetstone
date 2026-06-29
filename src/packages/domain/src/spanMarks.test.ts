import { describe, expect, it } from "vitest";

import { splitSpanIntoBlockRanges, type NoteSpan } from "./index.js";

const lengths = new Map([
  ["b1", 20],
  ["b2", 12],
  ["b3", 8]
]);
const ordered = ["b1", "b2", "b3"];

describe("splitSpanIntoBlockRanges", () => {
  it("returns the single range for a same-block span", () => {
    const span: NoteSpan = {
      blockEntryId: "b1",
      endBlockEntryId: "b1",
      endOffset: 9,
      startOffset: 4
    };

    expect(splitSpanIntoBlockRanges(span, ordered, lengths)).toEqual([
      { blockEntryId: "b1", endOffset: 9, startOffset: 4 }
    ]);
  });

  it("splits a two-block span: start block to its end, end block from 0 to the end offset", () => {
    const span: NoteSpan = {
      blockEntryId: "b1",
      endBlockEntryId: "b2",
      endOffset: 5,
      startOffset: 16
    };

    expect(splitSpanIntoBlockRanges(span, ordered, lengths)).toEqual([
      { blockEntryId: "b1", endOffset: 20, startOffset: 16 },
      { blockEntryId: "b2", endOffset: 5, startOffset: 0 }
    ]);
  });

  it("covers full middle blocks 0..length for a three-block span", () => {
    const span: NoteSpan = {
      blockEntryId: "b1",
      endBlockEntryId: "b3",
      endOffset: 3,
      startOffset: 18
    };

    expect(splitSpanIntoBlockRanges(span, ordered, lengths)).toEqual([
      { blockEntryId: "b1", endOffset: 20, startOffset: 18 },
      { blockEntryId: "b2", endOffset: 12, startOffset: 0 },
      { blockEntryId: "b3", endOffset: 3, startOffset: 0 }
    ]);
  });

  it("returns no ranges when an endpoint is not among the ordered blocks", () => {
    const span: NoteSpan = {
      blockEntryId: "b1",
      endBlockEntryId: "bX",
      endOffset: 1,
      startOffset: 0
    };

    expect(splitSpanIntoBlockRanges(span, ordered, lengths)).toEqual([]);
  });

  it("returns no ranges when the end block precedes the start block", () => {
    const span: NoteSpan = {
      blockEntryId: "b3",
      endBlockEntryId: "b1",
      endOffset: 4,
      startOffset: 1
    };

    expect(splitSpanIntoBlockRanges(span, ordered, lengths)).toEqual([]);
  });

  it("skips a block with an unknown length and a range that collapses to empty", () => {
    // b2 has no length entry (skipped); the end block's 0..0 range is empty (skipped) — leaving only
    // the start block's range.
    const partialLengths = new Map([
      ["b1", 20],
      ["b3", 0]
    ]);
    const span: NoteSpan = {
      blockEntryId: "b1",
      endBlockEntryId: "b3",
      endOffset: 0,
      startOffset: 5
    };

    expect(splitSpanIntoBlockRanges(span, ordered, partialLengths)).toEqual([
      { blockEntryId: "b1", endOffset: 20, startOffset: 5 }
    ]);
  });
});
