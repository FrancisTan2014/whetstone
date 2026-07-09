import { describe, expect, it } from "vitest";

import {
  captureReturnPoint,
  returnPillAriaLabel,
  returnPillLabel,
  shortenUnitTitle
} from "./returnPoint";

describe("captureReturnPoint", () => {
  it("captures the origin unit, block, and title before a jump that moves the reader", () => {
    expect(
      captureReturnPoint({
        origin: { blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" },
        targetBlockEntryId: "b-9"
      })
    ).toEqual({ blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" });
  });

  it("captures without a title when the origin unit is untitled", () => {
    const captured = captureReturnPoint({
      origin: { blockEntryId: "b-1", unitEntryId: "u-1" },
      targetBlockEntryId: "b-9"
    });

    expect(captured).toEqual({ blockEntryId: "b-1", unitEntryId: "u-1" });
    expect(captured && "unitTitle" in captured).toBe(false);
  });

  it("captures a unit-level move (no specific target block)", () => {
    expect(
      captureReturnPoint({
        origin: { blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" }
      })
    ).toEqual({ blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" });
  });

  it("captures nothing for a no-op jump whose target is the block the reader is already at", () => {
    expect(
      captureReturnPoint({
        origin: { blockEntryId: "b-1", unitEntryId: "u-1", unitTitle: "Chapter One" },
        targetBlockEntryId: "b-1"
      })
    ).toBeUndefined();
  });

  it("captures nothing when the origin block is not measurable", () => {
    expect(
      captureReturnPoint({
        origin: { blockEntryId: undefined, unitEntryId: "u-1" },
        targetBlockEntryId: "b-9"
      })
    ).toBeUndefined();
  });

  it("captures nothing when the origin unit is unknown", () => {
    expect(
      captureReturnPoint({
        origin: { blockEntryId: "b-1", unitEntryId: undefined },
        targetBlockEntryId: "b-9"
      })
    ).toBeUndefined();
  });
});

describe("shortenUnitTitle", () => {
  it("keeps a short title unchanged", () => {
    expect(shortenUnitTitle("Chapter 10")).toBe("Chapter 10");
  });

  it("truncates an over-long title with an ellipsis", () => {
    expect(shortenUnitTitle("A Very Long Chapter Title That Runs On And On")).toBe(
      "A Very Long Chapter Titl…"
    );
  });

  it("collapses an all-whitespace title to empty", () => {
    expect(shortenUnitTitle("   ")).toBe("");
  });
});

describe("returnPillLabel", () => {
  it("names the destination unit when a title is known", () => {
    expect(returnPillLabel("Chapter One")).toBe("Back to Chapter One");
  });

  it("falls back to plain Back with no title", () => {
    expect(returnPillLabel(undefined)).toBe("Back");
  });

  it("falls back to plain Back for a blank title", () => {
    expect(returnPillLabel("   ")).toBe("Back");
  });
});

describe("returnPillAriaLabel", () => {
  it("spells out the full destination without truncation", () => {
    expect(returnPillAriaLabel("A Very Long Chapter Title That Runs On And On")).toBe(
      "Back to A Very Long Chapter Title That Runs On And On"
    );
  });

  it("names a generic destination with no title", () => {
    expect(returnPillAriaLabel(undefined)).toBe("Back to your previous position");
  });

  it("names a generic destination for a blank title", () => {
    expect(returnPillAriaLabel("   ")).toBe("Back to your previous position");
  });
});
