import { describe, expect, it } from "vitest";

import {
  availableWorkSectionPlacements,
  buildHeadingOutline,
  HEADING_OUTLINE_PREFACE_LABEL,
  HEADING_OUTLINE_UNTITLED_LABEL,
  planWorkSectionInsertion,
  type HeadingOutlineSection,
  type HeadingOutlineUnit
} from "./headingOutline.js";

function unit(
  entryId: string,
  headingLevel?: number,
  title?: string,
  sections?: ReadonlyArray<HeadingOutlineSection>
): HeadingOutlineUnit {
  return {
    entryId,
    ...(headingLevel === undefined ? {} : { headingLevel }),
    ...(sections === undefined ? {} : { sections }),
    ...(title === undefined ? {} : { title })
  };
}

function section(anchor: string, level: number, title?: string): HeadingOutlineSection {
  return { anchor, level, ...(title === undefined ? {} : { title }) };
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

  // #865: a chapter-scale PDF unit's own in-unit sections — headings that do not start a new reading
  // unit — nest under it in the derived outline rather than vanishing into a flat unit list.
  describe("in-unit sections (#865)", () => {
    it("nests a chapter's sections under it, targeting the unit with the section's anchor", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [
          section("s1", 2, "Section 1.1"),
          section("s2", 2, "Section 1.2")
        ]),
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
          targetAnchor: "s1",
          targetUnitEntryId: "c1"
        },
        {
          depth: 1,
          entryId: "s2",
          label: "Section 1.2",
          orderIndex: 2,
          parentEntryId: "c1",
          targetAnchor: "s2",
          targetUnitEntryId: "c1"
        },
        { depth: 0, entryId: "c2", label: "Chapter 2", orderIndex: 3, targetUnitEntryId: "c2" }
      ]);
    });

    it("compresses a section that skips levels the same way a unit-level heading would", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [section("deep", 3, "Deep section")]),
        unit("c2", 1, "Chapter 2")
      ]);

      expect(outline.map((entry) => [entry.entryId, entry.depth, entry.parentEntryId])).toEqual([
        ["c1", 0, undefined],
        ["deep", 1, "c1"],
        ["c2", 0, undefined]
      ]);
    });

    it("nests a deeper section under a shallower one within the same chapter", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [
          section("s1", 2, "Section 1"),
          section("s1a", 3, "Section 1.a")
        ]),
        unit("c2", 1, "Chapter 2")
      ]);

      expect(outline.map((entry) => [entry.entryId, entry.depth, entry.parentEntryId])).toEqual([
        ["c1", 0, undefined],
        ["s1", 1, "c1"],
        ["s1a", 2, "s1"],
        ["c2", 0, undefined]
      ]);
    });

    it("labels an untitled section with the untitled fallback", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [section("s1", 2)]),
        unit("c2", 1, "Chapter 2")
      ]);

      expect(outline[1]).toMatchObject({ entryId: "s1", label: HEADING_OUTLINE_UNTITLED_LABEL });
    });

    it("closes a trailing open section branch when the next chapter starts", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [section("s1", 2, "Section 1")]),
        unit("c2", 1, "Chapter 2", [section("s2", 2, "Section 2")])
      ]);

      expect(outline.map((entry) => [entry.entryId, entry.depth, entry.parentEntryId])).toEqual([
        ["c1", 0, undefined],
        ["s1", 1, "c1"],
        ["c2", 0, undefined],
        ["s2", 1, "c2"]
      ]);
    });

    it("keeps orderIndex continuous across units and their sections", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [section("s1", 2, "Section 1")]),
        unit("c2", 1, "Chapter 2")
      ]);

      expect(outline.map((entry) => entry.orderIndex)).toEqual([0, 1, 2]);
    });

    it("leaves a unit-starting entry's targetAnchor absent", () => {
      const outline = buildHeadingOutline([
        unit("c1", 1, "Chapter 1", [section("s1", 2, "Section 1")]),
        unit("c2", 1, "Chapter 2")
      ]);

      expect(outline[0]?.targetAnchor).toBeUndefined();
      expect(outline[1]?.targetAnchor).toBe("s1");
    });
  });
});

describe("planWorkSectionInsertion", () => {
  const sections = (
    ...items: ReadonlyArray<readonly [unitEntryId: string, headingLevel?: number]>
  ) => items.map(([unitEntryId, headingLevel]) => ({ headingLevel, unitEntryId }));

  it("exposes creation only through Start and heading levels 1-3", () => {
    expect(availableWorkSectionPlacements(undefined)).toEqual(["next"]);
    expect(availableWorkSectionPlacements(1)).toEqual(["next", "child"]);
    expect(availableWorkSectionPlacements(2)).toEqual(["next", "child"]);
    expect(availableWorkSectionPlacements(3)).toEqual(["next"]);
    expect(availableWorkSectionPlacements(4)).toEqual([]);
  });

  it("creates Heading 1 immediately after Start and rejects a child of Start", () => {
    const units = sections(["start"], ["part", 1]);

    expect(planWorkSectionInsertion(units, "start", "next")).toEqual({
      headingLevel: 1,
      orderIndex: 1,
      status: "planned"
    });
    expect(planWorkSectionInsertion(units, "start", "child")).toEqual({
      status: "invalid_placement"
    });
  });

  it("places a same-level sibling after the complete descendant branch", () => {
    const units = sections(
      ["part-1", 1],
      ["chapter-1", 2],
      ["section-1", 3],
      ["chapter-2", 2],
      ["part-2", 1]
    );

    expect(planWorkSectionInsertion(units, "chapter-1", "next")).toEqual({
      headingLevel: 2,
      orderIndex: 3,
      status: "planned"
    });
    expect(planWorkSectionInsertion(units, "part-1", "next")).toEqual({
      headingLevel: 1,
      orderIndex: 4,
      status: "planned"
    });
  });

  it("appends the last child one level deeper, including across a skipped level", () => {
    const units = sections(["part", 1], ["deep-child", 3], ["next-part", 1]);

    expect(planWorkSectionInsertion(units, "part", "child")).toEqual({
      headingLevel: 2,
      orderIndex: 2,
      status: "planned"
    });
    expect(
      planWorkSectionInsertion(sections(["part", 1], ["chapter", 2]), "chapter", "child")
    ).toEqual({
      headingLevel: 3,
      orderIndex: 2,
      status: "planned"
    });
  });

  it("allows an H3 sibling but refuses children of H3 and all creation below H3", () => {
    expect(planWorkSectionInsertion(sections(["h3", 3]), "h3", "next")).toEqual({
      headingLevel: 3,
      orderIndex: 1,
      status: "planned"
    });
    expect(planWorkSectionInsertion(sections(["h3", 3]), "h3", "child")).toEqual({
      status: "invalid_placement"
    });
    expect(planWorkSectionInsertion(sections(["h4", 4]), "h4", "next")).toEqual({
      status: "invalid_placement"
    });
  });

  it("stops a branch at a following headless unit and rejects an unknown target", () => {
    const units = sections(["part", 1], ["chapter", 2], ["headless"]);

    expect(planWorkSectionInsertion(units, "part", "next")).toEqual({
      headingLevel: 1,
      orderIndex: 2,
      status: "planned"
    });
    expect(planWorkSectionInsertion(units, "missing", "next")).toEqual({
      status: "target_not_found"
    });
  });
});
