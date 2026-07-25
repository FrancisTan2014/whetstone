import { describe, expect, it } from "vitest";

import { winkLemmatizer } from "./lexicalLemmatizer.js";

// #715 morphology adapter. wink-lemmatizer ships noun/verb/adjective tables; adverbs pass through unchanged
// (WordNet has no adverb lemmatizer). Assertions cover an irregular case per open class and the adverb
// passthrough, and confirm the lower-cased stable key.

describe("winkLemmatizer", () => {
  it("reduces inflected nouns to their base lemma", () => {
    expect(winkLemmatizer("mice", "noun")).toBe("mouse");
    expect(winkLemmatizer("cars", "noun")).toBe("car");
  });

  it("reduces inflected verbs to their base lemma", () => {
    expect(winkLemmatizer("went", "verb")).toBe("go");
    expect(winkLemmatizer("running", "verb")).toBe("run");
  });

  it("reduces comparative/superlative adjectives to their base lemma", () => {
    expect(winkLemmatizer("hotter", "adjective")).toBe("hot");
    expect(winkLemmatizer("better", "adjective")).toBe("good");
  });

  it("returns an adverb unchanged but lower-cased", () => {
    expect(winkLemmatizer("Quickly", "adverb")).toBe("quickly");
  });
});
