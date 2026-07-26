import { describe, expect, it } from "vitest";

import { diffBlockSequences, isEmptyBlockChangeSet } from "./blockChangeSet.js";
import type { BlockSequenceEntry } from "./blockChangeSet.js";

// #762 pure change-set diff. Every arm — insert, delete, content change, reorder, and their combinations —
// is exercised without a database so the correction-marker classification is provably precise.

function seq(entries: ReadonlyArray<[string, string]>): BlockSequenceEntry[] {
  return entries.map(([id, contentKey]) => ({ contentKey, id }));
}

describe("diffBlockSequences", () => {
  it("reports an unchanged stream as empty", () => {
    const stream = seq([
      ["a", "A"],
      ["b", "B"]
    ]);
    const changeSet = diffBlockSequences(stream, stream);

    expect(changeSet).toEqual({ changed: [], inserted: [], moved: [], removed: [] });
    expect(isEmptyBlockChangeSet(changeSet)).toBe(true);
  });

  it("reports newly inserted blocks in after-order without moving the untouched survivors", () => {
    const before = seq([["a", "A"]]);
    const after = seq([
      ["x", "X"],
      ["a", "A"],
      ["y", "Y"]
    ]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.inserted).toEqual(["x", "y"]);
    expect(changeSet.changed).toEqual([]);
    expect(changeSet.moved).toEqual([]);
    expect(changeSet.removed).toEqual([]);
    expect(isEmptyBlockChangeSet(changeSet)).toBe(false);
  });

  it("reports removed blocks in before-order", () => {
    const before = seq([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"]
    ]);
    const after = seq([["b", "B"]]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.removed).toEqual(["a", "c"]);
    expect(changeSet.changed).toEqual([]);
    expect(changeSet.moved).toEqual([]);
    expect(changeSet.inserted).toEqual([]);
  });

  it("classifies a content edit as changed, never moved", () => {
    const before = seq([
      ["a", "A"],
      ["b", "B"]
    ]);
    const after = seq([
      ["a", "A"],
      ["b", "B2"]
    ]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.changed).toEqual(["b"]);
    expect(changeSet.moved).toEqual([]);
  });

  it("classifies a pure reorder of two blocks as moved on both", () => {
    const before = seq([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"]
    ]);
    const after = seq([
      ["a", "A"],
      ["c", "C"],
      ["b", "B"]
    ]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.moved).toEqual(["c", "b"]);
    expect(changeSet.changed).toEqual([]);
    expect(changeSet.inserted).toEqual([]);
    expect(changeSet.removed).toEqual([]);
  });

  it("does not flag survivors as moved merely because a deletion shifts absolute positions", () => {
    const before = seq([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"]
    ]);
    const after = seq([
      ["b", "B"],
      ["c", "C"]
    ]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.removed).toEqual(["a"]);
    expect(changeSet.moved).toEqual([]);
    expect(changeSet.changed).toEqual([]);
  });

  it("separates a changed block from a survivor that reorders around it", () => {
    // `a` moves after `b`; `b`'s content changes. `a` is content-identical but reordered → moved; `b` is a
    // content change → changed (its rank shift is not reported as a move).
    const before = seq([
      ["a", "A"],
      ["b", "B"]
    ]);
    const after = seq([
      ["b", "B2"],
      ["a", "A"]
    ]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.changed).toEqual(["b"]);
    expect(changeSet.moved).toEqual(["a"]);
  });

  it("reports every arm at once: insert, remove, change, and move", () => {
    const before = seq([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
      ["d", "D"]
    ]);
    const after = seq([
      ["c", "C"],
      ["b", "B2"],
      ["a", "A"],
      ["e", "E"]
    ]);

    const changeSet = diffBlockSequences(before, after);

    expect(changeSet.inserted).toEqual(["e"]);
    expect(changeSet.removed).toEqual(["d"]);
    expect(changeSet.changed).toEqual(["b"]);
    // Surviving order before (excluding removed d): [a, b, c]; after: [c, b, a]. `c` and `a` change rank;
    // `b` is a content change so it is not additionally reported as moved.
    expect(changeSet.moved).toEqual(["c", "a"]);
  });
});
