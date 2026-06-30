import { describe, expect, it } from "vitest";

import { externalDictionaryLinks, isEnglishHeadword } from "./externalDictionaries";

describe("externalDictionaryLinks", () => {
  it("deep-links the headword to Longman, Merriam-Webster, and Oxford Learner's", () => {
    expect(externalDictionaryLinks("colophon")).toEqual([
      { label: "Longman", url: "https://www.ldoceonline.com/dictionary/colophon" },
      { label: "Merriam-Webster", url: "https://www.merriam-webster.com/dictionary/colophon" },
      {
        label: "Oxford Learner's",
        url: "https://www.oxfordlearnersdictionaries.com/definition/english/colophon"
      }
    ]);
  });

  it("URL-encodes a multi-word or punctuated headword into the path", () => {
    expect(externalDictionaryLinks("ad hoc").map((link) => link.url)).toEqual([
      "https://www.ldoceonline.com/dictionary/ad%20hoc",
      "https://www.merriam-webster.com/dictionary/ad%20hoc",
      "https://www.oxfordlearnersdictionaries.com/definition/english/ad%20hoc"
    ]);
  });

  it("returns no links for a Chinese (CJK) headword, where English dictionaries are useless (#302)", () => {
    expect(externalDictionaryLinks("曰")).toEqual([]);
    expect(externalDictionaryLinks("汉典")).toEqual([]);
  });

  it("returns no links for a mixed headword that contains any CJK ideograph (#302)", () => {
    expect(externalDictionaryLinks("set 曰")).toEqual([]);
  });
});

describe("isEnglishHeadword", () => {
  it("is true for a Latin-script headword with no CJK", () => {
    expect(isEnglishHeadword("colophon")).toBe(true);
    expect(isEnglishHeadword("ad hoc")).toBe(true);
  });

  it("is false for a CJK headword", () => {
    expect(isEnglishHeadword("曰")).toBe(false);
  });

  it("is false for a headword with no Latin letters (digits/punctuation only)", () => {
    expect(isEnglishHeadword("123")).toBe(false);
  });

  it("is false when a Latin headword also carries a CJK ideograph", () => {
    expect(isEnglishHeadword("café 曰")).toBe(false);
  });
});
