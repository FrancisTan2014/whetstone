import { describe, expect, it } from "vitest";

import { describeNearMatchDifferences } from "./nearMatchDifferences.js";

// The factual word-level difference the near-match review shows (#714). It is evidence, not a verdict, so
// these tests pin the concrete word changes for the pair shapes near matching actually surfaces: a changed
// word (a spelling variant), an added word, a dropped word, several changes in one draft, and the identical
// key that yields nothing to compare.
describe("describeNearMatchDifferences", () => {
  it("reports a single changed word as one before/after segment", () => {
    expect(describeNearMatchDifferences("in terms of", "in term of")).toEqual([
      { after: "term", before: "terms" }
    ]);
  });

  it("reports a word only the draft has as an addition (empty before)", () => {
    expect(describeNearMatchDifferences("the cat sat", "the big cat sat")).toEqual([
      { after: "big", before: "" }
    ]);
  });

  it("reports a word only the candidate has as a removal (empty after)", () => {
    expect(describeNearMatchDifferences("the big cat sat", "the cat sat")).toEqual([
      { after: "", before: "big" }
    ]);
  });

  it("collapses a run of adjacent differing words into one segment", () => {
    expect(describeNearMatchDifferences("keep the old value", "keep a new value")).toEqual([
      { after: "a new", before: "the old" }
    ]);
  });

  it("keeps several separated changes as distinct ordered segments", () => {
    expect(
      describeNearMatchDifferences("read the first page slowly", "reads the last page slowly")
    ).toEqual([
      { after: "reads", before: "read" },
      { after: "last", before: "first" }
    ]);
  });

  it("preserves case, since the candidate and draft keys are case-sensitive", () => {
    expect(describeNearMatchDifferences("the US economy grows", "the us economy grows")).toEqual([
      { after: "us", before: "US" }
    ]);
  });

  it("returns no differences for two identical keys", () => {
    expect(describeNearMatchDifferences("same wording here", "same wording here")).toEqual([]);
  });
});
