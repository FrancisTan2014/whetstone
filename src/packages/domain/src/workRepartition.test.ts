import { describe, expect, it } from "vitest";

import {
  planSectionRepartition,
  planWorkContentReplacement,
  type RepartitionBlock,
  type RepartitionUnit
} from "./workRepartition.js";

// A running id generator so a plan's minted units are deterministic and assertable.
function minter(): () => string {
  let n = 0;
  return () => `new-${(n += 1)}`;
}

function heading(id: string): RepartitionBlock {
  return { id, isHeading: true };
}

function body(id: string): RepartitionBlock {
  return { id, isHeading: false };
}

function unit(entryId: string, ...blockIds: string[]): RepartitionUnit {
  return { blockIds, entryId };
}

describe("planSectionRepartition", () => {
  it("keeps a single heading-led section's identity when its leading heading survives", () => {
    // The edited unit's leading heading block (h1) is unchanged, so the unit id is preserved and no new
    // unit is minted even though the body blocks changed.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "b1")],
      mintUnitId: minter(),
      streamBlocks: [heading("h1"), body("b2")]
    });

    expect(plan.units).toEqual([{ blockIds: ["h1", "b2"], entryId: "u1", isNew: false }]);
    expect(plan.removedUnitEntryIds).toEqual([]);
    expect(plan.blockUnitEntryId.get("b2")).toBe("u1");
  });

  it("splits a pasted multi-heading draft into one bounded unit per heading", () => {
    // A novel pasted into one section: the first heading keeps the section's identity, each further heading
    // mints a new bounded unit, and every block maps to its unit.
    const mint = minter();
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "b1")],
      mintUnitId: mint,
      streamBlocks: [heading("h1"), body("b1"), heading("h2"), body("b2"), heading("h3")]
    });

    expect(plan.units).toEqual([
      { blockIds: ["h1", "b1"], entryId: "u1", isNew: false },
      { blockIds: ["h2", "b2"], entryId: "new-1", isNew: true },
      { blockIds: ["h3"], entryId: "new-2", isNew: true }
    ]);
    expect(plan.removedUnitEntryIds).toEqual([]);
    expect(plan.blockUnitEntryId.get("b2")).toBe("new-1");
    expect(plan.blockUnitEntryId.get("h3")).toBe("new-2");
  });

  it("keeps the edited section's identity when its leading heading is replaced in place", () => {
    // The learner rewrote the section's heading (h1 -> hx) in place. The section keeps its identity on its
    // first partition even though the leading block id changed, so u1 survives and no unit is minted.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "b1")],
      mintUnitId: minter(),
      streamBlocks: [heading("hx"), body("b1")]
    });

    expect(plan.units).toEqual([{ blockIds: ["hx", "b1"], entryId: "u1", isNew: false }]);
    expect(plan.removedUnitEntryIds).toEqual([]);
    expect(plan.blockUnitEntryId.get("hx")).toBe("u1");
  });

  it("mints a new opening unit and keeps the section's identity when a heading is inserted above it", () => {
    // The learner inserted a new heading (hx) ABOVE the section's original heading (h1). h1 still leads its
    // own partition, so it keeps u1; the new opening partition mints a fresh unit rather than stealing u1.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "b1")],
      mintUnitId: minter(),
      streamBlocks: [heading("hx"), heading("h1"), body("b1")]
    });

    expect(plan.units).toEqual([
      { blockIds: ["hx"], entryId: "new-1", isNew: true },
      { blockIds: ["h1", "b1"], entryId: "u1", isNew: false }
    ]);
    expect(plan.removedUnitEntryIds).toEqual([]);
  });

  it("merges a section whose leading heading was removed into the preceding unit", () => {
    // The edited unit (u2) lost its heading, so the caller extended the span to the preceding unit (u1) and
    // prepended u1's blocks. The stream is now headed by u1's heading: u1 absorbs u2's blocks and u2 is gone.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "a1"), unit("u2", "h2", "b1")],
      mintUnitId: minter(),
      streamBlocks: [heading("h1"), body("a1"), body("b1")]
    });

    expect(plan.units).toEqual([{ blockIds: ["h1", "a1", "b1"], entryId: "u1", isNew: false }]);
    expect(plan.removedUnitEntryIds).toEqual(["u2"]);
    expect(plan.blockUnitEntryId.get("b1")).toBe("u1");
    // u2 had no surviving block of its own (h2 deleted, b1 moved), so its position maps to the merged unit.
    expect(plan.removedUnitFallback.get("u2")).toBe("u1");
  });

  it("preserves a moved-down heading's identity and merges the preface into the preceding unit", () => {
    // The learner typed a paragraph above the section's heading: the leading block is now a body block, so
    // the caller merges left. The old heading (h2) still leads its own partition, so u2 keeps its identity.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "a1"), unit("u2", "h2", "b1")],
      mintUnitId: minter(),
      streamBlocks: [heading("h1"), body("a1"), body("intro"), heading("h2"), body("b1")]
    });

    expect(plan.units).toEqual([
      { blockIds: ["h1", "a1", "intro"], entryId: "u1", isNew: false },
      { blockIds: ["h2", "b1"], entryId: "u2", isNew: false }
    ]);
    expect(plan.removedUnitEntryIds).toEqual([]);
    expect(plan.blockUnitEntryId.get("intro")).toBe("u1");
  });

  it("keeps a headingless preface (Start) as one unit at the Work opening", () => {
    // The leading unit (order 0) has no heading. Its draft stays headless: one partition, identity preserved.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u0", "p1")],
      mintUnitId: minter(),
      streamBlocks: [body("p1"), body("p2")]
    });

    expect(plan.units).toEqual([{ blockIds: ["p1", "p2"], entryId: "u0", isNew: false }]);
    expect(plan.removedUnitEntryIds).toEqual([]);
  });

  it("splits a headingless opening followed by a new heading into a Start plus a chapter", () => {
    // A preface followed by a first heading: the headless run stays the leading unit, the heading opens a
    // new bounded unit.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u0", "p1")],
      mintUnitId: minter(),
      streamBlocks: [body("p1"), heading("h1"), body("b1")]
    });

    expect(plan.units).toEqual([
      { blockIds: ["p1"], entryId: "u0", isNew: false },
      { blockIds: ["h1", "b1"], entryId: "new-1", isNew: true }
    ]);
  });

  it("compresses several sections into one when all their headings are removed", () => {
    // Everything in the edited section collapsed to plain paragraphs and merged into the preface unit u0:
    // both u1 and u2 disappear and their positions fall back to the surviving unit.
    const plan = planSectionRepartition({
      affectedUnits: [unit("u0", "p1"), unit("u1", "h1", "b1"), unit("u2", "h2", "b2")],
      mintUnitId: minter(),
      streamBlocks: [body("p1"), body("b1"), body("b2")]
    });

    expect(plan.units).toEqual([{ blockIds: ["p1", "b1", "b2"], entryId: "u0", isNew: false }]);
    expect(plan.removedUnitEntryIds).toEqual(["u1", "u2"]);
    expect(plan.removedUnitFallback.get("u1")).toBe("u0");
    expect(plan.removedUnitFallback.get("u2")).toBe("u0");
  });

  it("falls a removed unit whose every block was deleted back to the span's first unit", () => {
    // u2 is dropped entirely (heading and body deleted); nothing of it survives, so its top-of-unit position
    // maps to the first surviving unit of the span (previous content).
    const plan = planSectionRepartition({
      affectedUnits: [unit("u1", "h1", "a1"), unit("u2", "h2", "b1")],
      mintUnitId: minter(),
      streamBlocks: [heading("h1"), body("a1")]
    });

    expect(plan.units).toEqual([{ blockIds: ["h1", "a1"], entryId: "u1", isNew: false }]);
    expect(plan.removedUnitEntryIds).toEqual(["u2"]);
    expect(plan.removedUnitFallback.get("u2")).toBe("u1");
  });
});

describe("planWorkContentReplacement", () => {
  it("removes every previous unit and plans the replacement as entirely new units", () => {
    const plan = planWorkContentReplacement({
      previousUnitEntryIds: ["old-1", "old-2"],
      replacementUnits: [unit("fresh-1", "a", "b"), unit("fresh-2", "c")]
    });

    expect(plan.units).toEqual([
      { blockIds: ["a", "b"], entryId: "fresh-1", isNew: true },
      { blockIds: ["c"], entryId: "fresh-2", isNew: true }
    ]);
    expect(plan.removedUnitEntryIds).toEqual(["old-1", "old-2"]);
    // Every replacement block maps to the unit that now holds it, so a surviving anchor follows its block.
    expect([...plan.blockUnitEntryId]).toEqual([
      ["a", "fresh-1"],
      ["b", "fresh-1"],
      ["c", "fresh-2"]
    ]);
  });

  it("lands a reader at the same relative depth when the Work is re-divided into fewer units", () => {
    // The very case a re-map exists for (#816): the same book, re-divided from four units into two. A
    // positional clamp would dump the last three readers on the final unit; proportional mapping keeps
    // each of them where they actually were in the book.
    const plan = planWorkContentReplacement({
      previousUnitEntryIds: ["old-1", "old-2", "old-3", "old-4"],
      replacementUnits: [unit("fresh-1", "a"), unit("fresh-2", "b")]
    });

    expect([...plan.removedUnitFallback]).toEqual([
      ["old-1", "fresh-1"],
      ["old-2", "fresh-1"],
      ["old-3", "fresh-2"],
      ["old-4", "fresh-2"]
    ]);
  });

  it("spreads readers across a Work re-divided into more units than it had", () => {
    // Growing the unit count must not pile everyone onto the first unit: each old unit maps to the start
    // of the stretch of new units that covers it.
    const plan = planWorkContentReplacement({
      previousUnitEntryIds: ["old-1", "old-2"],
      replacementUnits: [
        unit("fresh-1", "a"),
        unit("fresh-2", "b"),
        unit("fresh-3", "c"),
        unit("fresh-4", "d"),
        unit("fresh-5", "e")
      ]
    });

    expect([...plan.removedUnitFallback]).toEqual([
      ["old-1", "fresh-1"],
      ["old-2", "fresh-3"]
    ]);
  });

  it("plans a replacement for a Work that had no units at all", () => {
    const plan = planWorkContentReplacement({
      previousUnitEntryIds: [],
      replacementUnits: [unit("fresh-1", "a")]
    });

    expect(plan.removedUnitEntryIds).toEqual([]);
    expect([...plan.removedUnitFallback]).toEqual([]);
  });
});
