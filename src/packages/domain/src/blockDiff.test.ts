import { describe, expect, it } from "vitest";

import { blockSimilarity, diffBlocks } from "./blockDiff.js";

describe("blockSimilarity", () => {
  it("scores identical normalized text as 1", () => {
    expect(blockSimilarity("Hello world.", "Hello   world.")).toBe(1);
  });

  it("scores a light edit high and unrelated text low", () => {
    expect(blockSimilarity("The quick brown fox", "The quick brown fox jumps")).toBeGreaterThan(
      0.6
    );
    expect(blockSimilarity("Hello world.", "Completely unrelated prose")).toBeLessThan(0.3);
  });

  it("falls back to exact equality for sub-bigram strings", () => {
    expect(blockSimilarity("a", "a")).toBe(1);
    expect(blockSimilarity("a", "b")).toBe(0);
  });
});

describe("diffBlocks", () => {
  it("preserves ids for unchanged blocks", () => {
    const diff = diffBlocks(
      [
        { id: "b1", plaintext: "Alpha" },
        { id: "b2", plaintext: "Beta" }
      ],
      [{ plaintext: "Alpha" }, { plaintext: "Beta" }]
    );

    expect(diff.assignments).toEqual(["b1", "b2"]);
    expect(diff.removedIds).toEqual([]);
  });

  it("preserves the id of a lightly edited block", () => {
    const diff = diffBlocks(
      [{ id: "b1", plaintext: "The quick brown fox" }],
      [{ plaintext: "The quick brown fox jumps" }]
    );

    expect(diff.assignments).toEqual(["b1"]);
    expect(diff.removedIds).toEqual([]);
  });

  it("assigns new ids for inserted blocks and keeps surrounding ids", () => {
    const diff = diffBlocks(
      [
        { id: "b1", plaintext: "Alpha" },
        { id: "b2", plaintext: "Gamma" }
      ],
      [{ plaintext: "Alpha" }, { plaintext: "Beta inserted" }, { plaintext: "Gamma" }]
    );

    expect(diff.assignments).toEqual(["b1", undefined, "b2"]);
    expect(diff.removedIds).toEqual([]);
  });

  it("reports removed blocks for deletion while preserving the rest", () => {
    const diff = diffBlocks(
      [
        { id: "b1", plaintext: "Alpha" },
        { id: "b2", plaintext: "Beta to delete" },
        { id: "b3", plaintext: "Gamma" }
      ],
      [{ plaintext: "Alpha" }, { plaintext: "Gamma" }]
    );

    expect(diff.assignments).toEqual(["b1", "b3"]);
    expect(diff.removedIds).toEqual(["b2"]);
  });

  it("treats a replaced block as remove + add", () => {
    const diff = diffBlocks(
      [{ id: "b1", plaintext: "Original sentence here" }],
      [{ plaintext: "Totally different wording now" }]
    );

    expect(diff.assignments).toEqual([undefined]);
    expect(diff.removedIds).toEqual(["b1"]);
  });

  it("matches everything new when there are no existing blocks", () => {
    const diff = diffBlocks([], [{ plaintext: "Alpha" }, { plaintext: "Beta" }]);

    expect(diff.assignments).toEqual([undefined, undefined]);
    expect(diff.removedIds).toEqual([]);
  });

  it("removes all existing blocks when the new source is empty", () => {
    const diff = diffBlocks([{ id: "b1", plaintext: "Alpha" }], []);

    expect(diff.assignments).toEqual([]);
    expect(diff.removedIds).toEqual(["b1"]);
  });
});
