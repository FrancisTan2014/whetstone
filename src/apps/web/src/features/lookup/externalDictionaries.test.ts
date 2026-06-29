import { describe, expect, it } from "vitest";

import { externalDictionaryLinks } from "./externalDictionaries";

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
});
