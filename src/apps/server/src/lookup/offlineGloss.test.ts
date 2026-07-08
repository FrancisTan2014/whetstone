import { describe, expect, it } from "vitest";

import type { DictionaryEntry } from "@whetstone/contracts";

import { createOfflineGloss, extractGloss, isChineseText } from "./offlineGloss.js";

// Build a minimal DictionaryEntry from an ordered list of (partOfSpeech, definitions) groups, so a test
// can express exactly the shape the extractor reads without the wire noise (pronunciations, sources).
function entry(
  groups: ReadonlyArray<{ partOfSpeech?: string; definitions: ReadonlyArray<string> }>
): DictionaryEntry {
  return {
    headword: "term",
    partsOfSpeech: groups.map((group) => ({
      ...(group.partOfSpeech === undefined ? {} : { partOfSpeech: group.partOfSpeech }),
      senses: group.definitions.map((definition) => ({ definition, examples: [], synonyms: [] }))
    })),
    pronunciations: [],
    sources: []
  };
}

describe("isChineseText", () => {
  it("is true for text containing a Han ideograph", () => {
    expect(isChineseText("缓解")).toBe(true);
    expect(isChineseText("word 词")).toBe(true);
  });

  it("is false for Latin-script text", () => {
    expect(isChineseText("mitigation")).toBe(false);
    expect(isChineseText("")).toBe(false);
  });
});

describe("extractGloss", () => {
  it("takes the first sense of the first part of speech", () => {
    const gloss = extractGloss(
      entry([
        { partOfSpeech: "noun", definitions: ["a lessening", "the act of making less severe"] },
        { partOfSpeech: "verb", definitions: ["to make less severe"] }
      ])
    );

    expect(gloss).toBe("noun: a lessening");
  });

  it("omits the label when the part of speech is absent or blank", () => {
    expect(extractGloss(entry([{ definitions: ["a lessening"] }]))).toBe("a lessening");
    expect(extractGloss(entry([{ partOfSpeech: "  ", definitions: ["a lessening"] }]))).toBe(
      "a lessening"
    );
  });

  it("trims surrounding whitespace from the definition", () => {
    expect(extractGloss(entry([{ definitions: ["   spaced out   "] }]))).toBe("spaced out");
  });

  it("truncates an over-long gloss to the bound with an ellipsis", () => {
    const long = "x".repeat(500);
    const gloss = extractGloss(entry([{ definitions: [long] }]));

    expect(gloss).not.toBeNull();
    expect(gloss).toHaveLength(200);
    expect(gloss?.endsWith("\u2026")).toBe(true);
  });

  it("returns null for a not-found entry", () => {
    expect(extractGloss(null)).toBeNull();
  });

  it("returns null when the entry has no parts of speech", () => {
    expect(extractGloss(entry([]))).toBeNull();
  });

  it("returns null when the definition is blank", () => {
    expect(extractGloss(entry([{ partOfSpeech: "noun", definitions: ["   "] }]))).toBeNull();
  });
});

describe("createOfflineGloss", () => {
  const english = entry([{ partOfSpeech: "noun", definitions: ["a lessening"] }]);
  const chinese = entry([{ definitions: ["to relieve"] }]);

  function sources(seen: { english: string[]; chinese: string[] }) {
    return {
      english: async (term: string) => {
        seen.english.push(term);
        return english;
      },
      chinese: async (term: string) => {
        seen.chinese.push(term);
        return chinese;
      }
    };
  }

  it("routes Latin text to the English source", async () => {
    const seen = { english: [] as string[], chinese: [] as string[] };
    const resolve = createOfflineGloss(sources(seen));

    expect(await resolve("mitigation")).toBe("noun: a lessening");
    expect(seen.english).toEqual(["mitigation"]);
    expect(seen.chinese).toEqual([]);
  });

  it("routes Han text to the Chinese source", async () => {
    const seen = { english: [] as string[], chinese: [] as string[] };
    const resolve = createOfflineGloss(sources(seen));

    expect(await resolve("缓解")).toBe("to relieve");
    expect(seen.chinese).toEqual(["缓解"]);
    expect(seen.english).toEqual([]);
  });

  it("trims the term before looking it up", async () => {
    const seen = { english: [] as string[], chinese: [] as string[] };
    const resolve = createOfflineGloss(sources(seen));

    await resolve("  mitigation  ");
    expect(seen.english).toEqual(["mitigation"]);
  });

  it("returns null for a blank term without hitting a source", async () => {
    const seen = { english: [] as string[], chinese: [] as string[] };
    const resolve = createOfflineGloss(sources(seen));

    expect(await resolve("   ")).toBeNull();
    expect(seen.english).toEqual([]);
    expect(seen.chinese).toEqual([]);
  });

  it("returns null when the source does not know the term", async () => {
    const resolve = createOfflineGloss({
      english: async () => null,
      chinese: async () => null
    });

    expect(await resolve("unknownium")).toBeNull();
  });

  it("fails soft to null when a source throws", async () => {
    const resolve = createOfflineGloss({
      english: async () => {
        throw new Error("dictionary exploded");
      },
      chinese: async () => null
    });

    expect(await resolve("mitigation")).toBeNull();
  });
});
