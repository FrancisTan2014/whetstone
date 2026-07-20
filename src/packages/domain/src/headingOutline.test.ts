import { describe, expect, it } from "vitest";

import {
  buildHeadingOutline,
  HEADING_OUTLINE_PREFACE_LABEL,
  HEADING_OUTLINE_UNTITLED_LABEL,
  type HeadingOutlineUnit
} from "./headingOutline.js";

function unit(entryId: string, headingLevel?: number, title?: string): HeadingOutlineUnit {
  return {
    entryId,
    ...(headingLevel === undefined ? {} : { headingLevel }),
    ...(title === undefined ? {} : { title })
  };
}

describe("buildHeadingOutline", () => {
  it("returns no outline for a single-unit work", () => {
    expect(buildHeadingOutline([unit("u1", 1, "Only chapter")])).toEqual([]);
  });

  it("returns no outline for an empty unit list", () => {
    expect(buildHeadingOutline([])).toEqual([]);
  });

  it("returns no outline when no unit carries a heading level", () => {
    expect(buildHeadingOutline([unit("u1"), unit("u2")])).toEqual([]);
  });

  it("nests headings under the nearest lower-level preceding heading", () => {
    const outline = buildHeadingOutline([
      unit("c1", 1, "Chapter 1"),
      unit("s1", 2, "Section 1.1"),
      unit("s2", 2, "Section 1.2"),
      unit("c2", 1, "Chapter 2")
    ]);

    expect(outline).toEqual([
      { depth: 0, entryId: "c1", label: "Chapter 1", orderIndex: 0, targetUnitEntryId: "c1" },
      {
        depth: 1,
        entryId: "s1",
        label: "Section 1.1",
        orderIndex: 1,
        parentEntryId: "c1",
        targetUnitEntryId: "s1"
      },
      {
        depth: 1,
        entryId: "s2",
        label: "Section 1.2",
        orderIndex: 2,
        parentEntryId: "c1",
        targetUnitEntryId: "s2"
      },
      { depth: 0, entryId: "c2", label: "Chapter 2", orderIndex: 3, targetUnitEntryId: "c2" }
    ]);
  });

  it("builds three levels of nesting when levels descend by one", () => {
    const outline = buildHeadingOutline([
      unit("h1", 1, "One"),
      unit("h2", 2, "Two"),
      unit("h3", 3, "Three")
    ]);

    expect(outline.map((entry) => [entry.entryId, entry.depth, entry.parentEntryId])).toEqual([
      ["h1", 0, undefined],
      ["h2", 1, "h1"],
      ["h3", 2, "h2"]
    ]);
  });

  it("compresses a skipped level to one nesting step", () => {
    const outline = buildHeadingOutline([unit("h1", 1, "One"), unit("h3", 3, "Deep")]);

    expect(outline).toEqual([
      { depth: 0, entryId: "h1", label: "One", orderIndex: 0, targetUnitEntryId: "h1" },
      {
        depth: 1,
        entryId: "h3",
        label: "Deep",
        orderIndex: 1,
        parentEntryId: "h1",
        targetUnitEntryId: "h3"
      }
    ]);
  });

  it("closes a deeper branch when a shallower heading follows", () => {
    const outline = buildHeadingOutline([
      unit("h1", 1, "One"),
      unit("h2", 2, "Under one"),
      unit("h1b", 1, "Two")
    ]);

    expect(outline.map((entry) => [entry.entryId, entry.depth, entry.parentEntryId])).toEqual([
      ["h1", 0, undefined],
      ["h2", 1, "h1"],
      ["h1b", 0, undefined]
    ]);
  });

  it("emits leading content before the first heading as a root Start entry", () => {
    const outline = buildHeadingOutline([
      unit("preface"),
      unit("c1", 1, "Chapter 1"),
      unit("s1", 2, "Section")
    ]);

    expect(outline[0]).toEqual({
      depth: 0,
      entryId: "preface",
      label: HEADING_OUTLINE_PREFACE_LABEL,
      orderIndex: 0,
      targetUnitEntryId: "preface"
    });
    // The first chapter is a sibling root of Start, not a child of it.
    expect(outline[1]).toMatchObject({ depth: 0, entryId: "c1" });
    expect(outline[1]?.parentEntryId).toBeUndefined();
  });

  it("labels an untitled heading with the untitled fallback", () => {
    const outline = buildHeadingOutline([unit("c1", 1, "Chapter 1"), unit("c2", 1)]);

    expect(outline[1]).toMatchObject({ entryId: "c2", label: HEADING_OUTLINE_UNTITLED_LABEL });
  });

  it("preserves source order in orderIndex", () => {
    const outline = buildHeadingOutline([unit("a", 1, "A"), unit("b", 2, "B"), unit("c", 1, "C")]);

    expect(outline.map((entry) => entry.orderIndex)).toEqual([0, 1, 2]);
  });
});
