import { describe, expect, it } from "vitest";

import type { ReaderStructure, ReaderTocEntry, ReaderUnitMeta } from "./readerModel";
import {
  activeTocEntryId,
  clampUnitIndex,
  resolveTocEntryNavigation,
  unitIndexForEntryId,
  unitTocLabel,
  workProgress
} from "./readerNavigation";
import { buildAnchorIndex, type AnchorIndex } from "./referenceResolver";

const structure: ReaderStructure = {
  units: [
    { blockCount: 2, entryId: "u-1", orderIndex: 0, title: "Chapter One" },
    { blockCount: 1, entryId: "u-2", orderIndex: 1 }
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
      orderIndex: 0,
      sourceFile: "OEBPS/chap1.xhtml",
      title: "Chapter One"
    },
    { blockCount: 2, entryId: "u-2", orderIndex: 1, sourceFile: "OEBPS/chap2.xhtml" },
    { blockCount: 1, entryId: "u-3", orderIndex: 2 }
  ],
  workEntryId: "work-1"
};

const anchorIndex: AnchorIndex = buildAnchorIndex({
  anchors: [
    { anchor: "sec-2", blockEntryId: "block-sec-2", sourceFile: "OEBPS/chap1.xhtml", unitEntryId: "u-1" },
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
      resolveTocEntryNavigation(tocStructure, anchorIndex, tocEntry({ targetUnitEntryId: "u-gone" }))
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

  it("no-ops a #fragment entry whose anchor does not resolve", () => {
    expect(
      resolveTocEntryNavigation(
        tocStructure,
        anchorIndex,
        tocEntry({ targetAnchor: "missing", targetUnitEntryId: "u-1" })
      )
    ).toEqual({ kind: "none" });
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
