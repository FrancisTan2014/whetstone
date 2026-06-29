import { describe, expect, it } from "vitest";

import {
  lookupResponseSchema,
  lookupSourceLabel,
  lookupSourcesForLanguage,
  parseLookupRequest,
  parseLookupResponse
} from "./lookupContracts.js";

describe("parseLookupRequest", () => {
  it("accepts an English term and trims surrounding whitespace", () => {
    expect(
      parseLookupRequest({ language: "en", source: "wordnet", term: "  voluminous  " })
    ).toEqual({
      language: "en",
      source: "wordnet",
      term: "voluminous"
    });
  });

  it("rejects a blank term", () => {
    expect(() => parseLookupRequest({ language: "en", source: "wordnet", term: "   " })).toThrow();
  });

  it("accepts the Chinese work languages", () => {
    expect(parseLookupRequest({ language: "zh-CN", source: "cedict", term: "你好" })).toEqual({
      language: "zh-CN",
      source: "cedict",
      term: "你好"
    });
    expect(parseLookupRequest({ language: "zh-TW", source: "cedict", term: "中國" })).toEqual({
      language: "zh-TW",
      source: "cedict",
      term: "中國"
    });
  });

  it("rejects an unsupported language", () => {
    expect(() =>
      parseLookupRequest({ language: "fr", source: "wordnet", term: "bonjour" })
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => parseLookupRequest({ language: "en", source: "bogus", term: "word" })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      parseLookupRequest({ extra: 1, language: "en", source: "wordnet", term: "word" })
    ).toThrow();
  });
});

describe("lookupSourcesForLanguage", () => {
  it("leads English with offline WordNet then Wiktionary, and Chinese with 萌典 then CC-CEDICT", () => {
    expect(lookupSourcesForLanguage("en")).toEqual(["wordnet", "wiktionary"]);
    expect(lookupSourcesForLanguage("zh-CN")).toEqual(["moedict", "cedict"]);
    expect(lookupSourcesForLanguage("zh-TW")).toEqual(["moedict", "cedict"]);
    expect(lookupSourcesForLanguage("fr")).toEqual([]);
  });

  it("labels each source", () => {
    expect(lookupSourceLabel("wordnet")).toBe("WordNet");
    expect(lookupSourceLabel("wiktionary")).toBe("Wiktionary");
    expect(lookupSourceLabel("cedict")).toBe("CC-CEDICT");
    expect(lookupSourceLabel("moedict")).toBe("萌典");
  });
});

describe("parseLookupResponse", () => {
  it("accepts a found entry with all fields", () => {
    const response = {
      entry: {
        etymology: "From Old English.",
        headword: "word",
        partsOfSpeech: [
          {
            partOfSpeech: "noun",
            senses: [
              {
                definition: "a unit of language",
                examples: ["a kind word"],
                synonyms: ["term", "expression"]
              }
            ]
          }
        ],
        pronunciations: [{ audio: "https://audio.example/word.mp3", ipa: "wɜːd" }],
        sources: ["WordNet", "Wiktionary"]
      },
      found: true
    };

    expect(parseLookupResponse(response)).toEqual(response);
  });

  it("accepts a found entry without optional fields", () => {
    const response = {
      entry: {
        headword: "word",
        partsOfSpeech: [{ senses: [{ definition: "meaning", examples: [], synonyms: [] }] }],
        pronunciations: [],
        sources: []
      },
      found: true
    };

    expect(parseLookupResponse(response)).toEqual(response);
  });

  it("accepts an explicit not-found result", () => {
    expect(parseLookupResponse({ found: false })).toEqual({ found: false });
  });

  it("rejects a found result missing its entry", () => {
    expect(lookupResponseSchema.safeParse({ found: true }).success).toBe(false);
  });
});
