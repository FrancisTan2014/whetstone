import { describe, expect, it } from "vitest";

import type { ReaderStructure, ReaderTocEntry, ReaderUnitMeta } from "./readerModel";
import {
  activeTocEntryId,
  activeTocEntryIdForPosition,
  clampUnitIndex,
  firstSubstantiveUnitIndex,
  resolveTocEntryNavigation,
  unitIndexForEntryId,
  unitTocLabel,
  workProgress
} from "./readerNavigation";
import { buildAnchorIndex, type AnchorIndex } from "./referenceResolver";

const structure: ReaderStructure = {
  units: [
    {
      blockCount: 2,
      entryId: "u-1",
      hasSubstantiveText: true,
      orderIndex: 0,
      title: "Chapter One"
    },
    { blockCount: 1, entryId: "u-2", hasSubstantiveText: true, orderIndex: 1 }
  ],
  workEntryId: "work-1"
};

const emptyStructure: ReaderStructure = { units: [], workEntryId: "work-empty" };

describe("unitIndexForEntryId", () => {
  it("finds the index of the unit with the given entry id", () => {
    expect(unitIndexForEntryId(structure, "u-1")).toBe(0);
    expect(unitIndexForEntryId(structure, "u-2")).toBe(1);
  });

  it("returns undefined when no unit has the entry id", () => {
    expect(unitIndexForEntryId(structure, "u-missing")).toBeUndefined();
  });
});

describe("clampUnitIndex", () => {
  it("clamps into the valid unit range", () => {
    expect(clampUnitIndex(structure, -3)).toBe(0);
    expect(clampUnitIndex(structure, 1)).toBe(1);
    expect(clampUnitIndex(structure, 9)).toBe(1);
  });

  it("clamps to 0 for an empty work", () => {
    expect(clampUnitIndex(emptyStructure, 4)).toBe(0);
  });
});

describe("firstSubstantiveUnitIndex", () => {
  it("returns the first unit index when the first unit has substantive text", () => {
    expect(firstSubstantiveUnitIndex(structure)).toBe(0);
  });

  it("skips leading front matter to the first substantive unit (#394)", () => {
    const withFrontMatter: ReaderStructure = {
      units: [
        { blockCount: 1, entryId: "cover", hasSubstantiveText: false, orderIndex: 0 },
        { blockCount: 1, entryId: "plate", hasSubstantiveText: false, orderIndex: 1 },
        { blockCount: 4, entryId: "body", hasSubstantiveText: true, orderIndex: 2 }
      ],
      workEntryId: "work-fm"
    };

    expect(firstSubstantiveUnitIndex(withFrontMatter)).toBe(2);
  });

  it("returns undefined when every unit is front matter (#394)", () => {
    const allFrontMatter: ReaderStructure = {
      units: [{ blockCount: 1, entryId: "cover", hasSubstantiveText: false, orderIndex: 0 }],
      workEntryId: "work-fm-only"
    };

    expect(firstSubstantiveUnitIndex(allFrontMatter)).toBeUndefined();
  });

  it("returns undefined for an empty work", () => {
    expect(firstSubstantiveUnitIndex(emptyStructure)).toBeUndefined();
  });
});

describe("unitTocLabel", () => {
  it("uses the unit title when present", () => {
    expect(unitTocLabel(structure.units[0] as ReaderUnitMeta, 0)).toBe("Chapter One");
  });

  it("falls back to an ordinal for an untitled unit", () => {
    expect(unitTocLabel(structure.units[1] as ReaderUnitMeta, 1)).toBe("Section 2");
  });
});

describe("workProgress", () => {
  it("is zero for a work with no units", () => {
    expect(workProgress(0, 0, 0.5)).toBe(0);
  });

  it("combines the unit position with the within-unit scroll fraction", () => {
    expect(workProgress(0, 2, 0)).toBe(0);
    expect(workProgress(0, 2, 0.5)).toBe(0.25);
    expect(workProgress(1, 2, 0)).toBe(0.5);
  });

  it("clamps the within-unit fraction and the overall result", () => {
    expect(workProgress(1, 2, -1)).toBe(0.5);
    expect(workProgress(1, 2, 5)).toBe(1);
  });
});

const tocStructure: ReaderStructure = {
  units: [
    {
      blockCount: 3,
      entryId: "u-1",
      hasSubstantiveText: true,
      orderIndex: 0,
      sourceFile: "OEBPS/chap1.xhtml",
      title: "Chapter One"
    },
    {
      blockCount: 2,
      entryId: "u-2",
      hasSubstantiveText: true,
      orderIndex: 1,
      sourceFile: "OEBPS/chap2.xhtml"
    },
    { blockCount: 1, entryId: "u-3", hasSubstantiveText: true, orderIndex: 2 }
  ],
  workEntryId: "work-1"
};

const anchorIndex: AnchorIndex = buildAnchorIndex({
  anchors: [
    {
      anchor: "sec-2",
      blockEntryId: "block-sec-2",
      sourceFile: "OEBPS/chap1.xhtml",
      unitEntryId: "u-1"
    },
    { anchor: "note-a", blockEntryId: "block-note-a", sourceFile: null, unitEntryId: "u-3" }
  ],
  workEntryId: "work-1"
});

function tocEntry(overrides: Partial<ReaderTocEntry>): ReaderTocEntry {
  return { depth: 0, entryId: "e", label: "Entry", orderIndex: 0, ...overrides };
}

describe("resolveTocEntryNavigation", () => {
  it("no-ops an entry with no target unit", () => {
    expect(resolveTocEntryNavigation(tocStructure, anchorIndex, tocEntry({}))).toEqual({
      kind: "none"
    });
  });

  it("no-ops an entry whose target unit is not in the structure", () => {
    expect(
      resolveTocEntryNavigation(
        tocStructure,
        anchorIndex,
        tocEntry({ targetUnitEntryId: "u-gone" })
      )
    ).toEqual({ kind: "none" });
  });

  it("opens a whole-file entry's unit at its top", () => {
    expect(
      resolveTocEntryNavigation(tocStructure, anchorIndex, tocEntry({ targetUnitEntryId: "u-2" }))
    ).toEqual({ kind: "unit", unitIndex: 1 });
  });

  it("jumps to the block a resolvable #fragment entry points at", () => {
    expect(
      resolveTocEntryNavigation(
        tocStructure,
        anchorIndex,
        tocEntry({ targetAnchor: "sec-2", targetUnitEntryId: "u-1" })
      )
    ).toEqual({ blockEntryId: "block-sec-2", kind: "block" });
  });

  it("resolves a #fragment against a source-file-less unit via the empty-file key", () => {
    expect(
      resolveTocEntryNavigation(
        tocStructure,
        anchorIndex,
        tocEntry({ targetAnchor: "note-a", targetUnitEntryId: "u-3" })
      )
    ).toEqual({ blockEntryId: "block-note-a", kind: "block" });
  });

  it("falls back to opening the target unit's top when a #fragment does not resolve (#495)", () => {
    // A cross-chapter TOC jump: the target unit's blocks are not loaded, so its anchor is not in the
    // index. Rather than no-op (leaving the reader on the current chapter), open the target unit.
    expect(
      resolveTocEntryNavigation(
        tocStructure,
        anchorIndex,
        tocEntry({ targetAnchor: "missing", targetUnitEntryId: "u-1" })
      )
    ).toEqual({ kind: "unit", unitIndex: 0 });
  });
});

describe("activeTocEntryId", () => {
  const entries: ReadonlyArray<ReaderTocEntry> = [
    tocEntry({ entryId: "e-1", targetUnitEntryId: "u-1" }),
    tocEntry({ entryId: "e-1-dup", targetUnitEntryId: "u-1" }),
    tocEntry({ entryId: "e-2", targetUnitEntryId: "u-2" })
  ];

  it("is undefined when no unit is active", () => {
    expect(activeTocEntryId(entries, undefined)).toBeUndefined();
  });

  it("marks the first entry that opens the active unit", () => {
    expect(activeTocEntryId(entries, "u-1")).toBe("e-1");
    expect(activeTocEntryId(entries, "u-2")).toBe("e-2");
  });

  it("is undefined when no entry targets the active unit", () => {
    expect(activeTocEntryId(entries, "u-3")).toBeUndefined();
  });
});

describe("activeTocEntryIdForPosition", () => {
  // Chapter one (u-1) has a top intro then two authored sections; chapter two (u-2) is a separate unit.
  const entries: ReadonlyArray<ReaderTocEntry> = [
    tocEntry({ depth: 0, entryId: "e-ch", targetUnitEntryId: "u-1" }),
    tocEntry({
      depth: 1,
      entryId: "e-s1",
      parentEntryId: "e-ch",
      targetAnchor: "sec-1",
      targetUnitEntryId: "u-1"
    }),
    tocEntry({
      depth: 1,
      entryId: "e-s2",
      parentEntryId: "e-ch",
      targetAnchor: "sec-2",
      targetUnitEntryId: "u-1"
    }),
    tocEntry({
      depth: 1,
      entryId: "e-bad",
      parentEntryId: "e-ch",
      targetAnchor: "gone",
      targetUnitEntryId: "u-1"
    }),
    tocEntry({ depth: 0, entryId: "e-2", targetUnitEntryId: "u-2" })
  ];

  // u-1's ordered blocks: intro (b0), section one starts at b1, section two starts at b3.
  const unitBlocks = [
    { entryId: "b0" },
    { anchorId: "sec-1", entryId: "b1" },
    { entryId: "b2" },
    { anchorId: "sec-2", entryId: "b3" },
    { entryId: "b4" }
  ];

  it("falls back to the chapter floor when there is no current block", () => {
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, undefined)).toBe("e-ch");
  });

  it("is undefined when no unit is active", () => {
    expect(activeTocEntryIdForPosition(entries, undefined, unitBlocks, "b2")).toBeUndefined();
  });

  it("is undefined when no entry targets the active unit", () => {
    expect(activeTocEntryIdForPosition(entries, "u-3", unitBlocks, "b2")).toBeUndefined();
  });

  it("falls back to the chapter floor at the top of the unit", () => {
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, "b0")).toBe("e-ch");
  });

  it("reveals the deepest section the restored block falls within", () => {
    // b2 is inside section one (b1..b2); b3/b4 are inside section two.
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, "b2")).toBe("e-s1");
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, "b3")).toBe("e-s2");
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, "b4")).toBe("e-s2");
  });

  it("ignores a section whose anchor is not among the unit's blocks", () => {
    // e-bad ("gone") never resolves, so a position past section two still picks section two.
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, "b4")).toBe("e-s2");
  });

  it("falls back to the chapter floor when the current block is not in the active unit", () => {
    expect(activeTocEntryIdForPosition(entries, "u-1", unitBlocks, "other-unit-block")).toBe(
      "e-ch"
    );
  });

  it("resolves a tie to the deeper (later pre-order) entry sharing the same start block", () => {
    const tied: ReadonlyArray<ReaderTocEntry> = [
      tocEntry({ depth: 0, entryId: "e-top", targetUnitEntryId: "u-1" }),
      tocEntry({
        depth: 1,
        entryId: "e-top-section",
        parentEntryId: "e-top",
        targetAnchor: "sec-0",
        targetUnitEntryId: "u-1"
      })
    ];
    const blocks = [{ anchorId: "sec-0", entryId: "b0" }, { entryId: "b1" }];

    expect(activeTocEntryIdForPosition(tied, "u-1", blocks, "b0")).toBe("e-top-section");
  });
});
