import { describe, expect, it } from "vitest";

import type { ReaderStructure, ReaderUnitMeta } from "./readerModel";
import {
  clampUnitIndex,
  unitIndexForEntryId,
  unitTocLabel,
  workProgress
} from "./readerNavigation";

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
