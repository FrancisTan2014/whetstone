import { describe, expect, it } from "vitest";

import { isCjkText, segmentWordAt } from "./segmentWord";

describe("segmentWordAt", () => {
  it("snaps an offset inside a CJK word to the whole word (六艺, not 六)", () => {
    const text = "六艺者，礼乐射御书数也。";

    // A tap on either character of 六艺 resolves to the whole two-character word.
    expect(segmentWordAt(text, 0, "zh")).toEqual({ end: 2, start: 0, text: "六艺" });
    expect(segmentWordAt(text, 1, "zh")).toEqual({ end: 2, start: 0, text: "六艺" });
  });

  it("resolves a later CJK word by its own offset", () => {
    const text = "六艺者，礼乐射御书数也。";

    // 礼乐射御 begins at index 4 (after 六艺者，).
    expect(segmentWordAt(text, 5, "zh")).toEqual({ end: 8, start: 4, text: "礼乐射御" });
  });

  it("returns undefined for a tap on CJK punctuation (not word-like)", () => {
    // The 、 / ， marks segment as non-word-like, so a tap there keeps the raw selection.
    expect(segmentWordAt("六艺，礼乐", 2, "zh")).toBeUndefined();
  });

  it("returns the Latin word for an ASCII offset (passthrough segmentation)", () => {
    expect(segmentWordAt("hello world", 1, "en")).toEqual({ end: 5, start: 0, text: "hello" });
  });

  it("returns undefined when the offset falls outside the text", () => {
    expect(segmentWordAt("六艺", 5, "zh")).toBeUndefined();
  });

  it("falls back to undefined when Intl.Segmenter is unavailable", () => {
    const intl = Intl as { Segmenter?: unknown };
    const original = intl.Segmenter;
    delete intl.Segmenter;

    try {
      expect(segmentWordAt("六艺", 0, "zh")).toBeUndefined();
    } finally {
      intl.Segmenter = original;
    }
  });
});

describe("isCjkText", () => {
  it("is true for Han and kana, false for Latin and CJK punctuation", () => {
    expect(isCjkText("六艺")).toBe(true);
    expect(isCjkText("かな")).toBe(true);
    expect(isCjkText("カナ")).toBe(true);
    expect(isCjkText("hello")).toBe(false);
    expect(isCjkText("，。")).toBe(false);
  });
});
