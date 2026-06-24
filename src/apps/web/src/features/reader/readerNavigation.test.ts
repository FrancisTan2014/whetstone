import { describe, expect, it } from "vitest";

import type { ReaderUnit, ReaderView } from "./readerModel";
import {
  clampUnitIndex,
  initialUnitIndex,
  targetUnitForBlock,
  unitIndexOfBlock,
  unitTocLabel,
  workProgress
} from "./readerNavigation";

function block(entryId: string): ReaderUnit["blocks"][number] {
  return { entryId, isHeading: false, markdown: entryId, plaintext: entryId };
}

const view: ReaderView = {
  units: [
    { blocks: [block("b-1a"), block("b-1b")], entryId: "u-1", title: "Chapter One" },
    { blocks: [block("b-2a")], entryId: "u-2" }
  ],
  workEntryId: "work-1"
};

const emptyView: ReaderView = { units: [], workEntryId: "work-empty" };

describe("unitIndexOfBlock", () => {
  it("finds the unit that holds a block", () => {
    expect(unitIndexOfBlock(view, "b-1b")).toBe(0);
    expect(unitIndexOfBlock(view, "b-2a")).toBe(1);
  });

  it("returns undefined when no unit holds the block", () => {
    expect(unitIndexOfBlock(view, "b-missing")).toBeUndefined();
  });
});

describe("initialUnitIndex", () => {
  it("opens the first unit when no block is deep-linked", () => {
    expect(initialUnitIndex(view)).toBe(0);
  });

  it("opens the unit holding the deep-linked block", () => {
    expect(initialUnitIndex(view, "b-2a")).toBe(1);
  });

  it("falls back to the first unit when the deep-linked block is unknown", () => {
    expect(initialUnitIndex(view, "b-missing")).toBe(0);
  });
});

describe("targetUnitForBlock", () => {
  it("returns the unit that holds the block", () => {
    expect(targetUnitForBlock(view, "b-2a", 0)).toBe(1);
  });

  it("returns the fallback when the block is not in the work", () => {
    expect(targetUnitForBlock(view, "b-missing", 0)).toBe(0);
  });
});

describe("clampUnitIndex", () => {
  it("clamps into the valid unit range", () => {
    expect(clampUnitIndex(view, -3)).toBe(0);
    expect(clampUnitIndex(view, 1)).toBe(1);
    expect(clampUnitIndex(view, 9)).toBe(1);
  });

  it("clamps to 0 for an empty work", () => {
    expect(clampUnitIndex(emptyView, 4)).toBe(0);
  });
});

describe("unitTocLabel", () => {
  it("uses the unit title when present", () => {
    expect(unitTocLabel(view.units[0] as ReaderUnit, 0)).toBe("Chapter One");
  });

  it("falls back to an ordinal for an untitled unit", () => {
    expect(unitTocLabel(view.units[1] as ReaderUnit, 1)).toBe("Section 2");
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
