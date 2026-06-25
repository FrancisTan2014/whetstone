import { describe, expect, it } from "vitest";

import {
  lookupResponseSchema,
  parseLookupRequest,
  parseLookupResponse
} from "./lookupContracts.js";

describe("parseLookupRequest", () => {
  it("accepts an English term and trims surrounding whitespace", () => {
    expect(parseLookupRequest({ language: "en", term: "  voluminous  " })).toEqual({
      language: "en",
      term: "voluminous"
    });
  });

  it("rejects a blank term", () => {
    expect(() => parseLookupRequest({ language: "en", term: "   " })).toThrow();
  });

  it("accepts the Chinese work languages", () => {
    expect(parseLookupRequest({ language: "zh-CN", term: "你好" })).toEqual({
      language: "zh-CN",
      term: "你好"
    });
    expect(parseLookupRequest({ language: "zh-TW", term: "中國" })).toEqual({
      language: "zh-TW",
      term: "中國"
    });
  });

  it("rejects an unsupported language", () => {
    expect(() => parseLookupRequest({ language: "fr", term: "bonjour" })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseLookupRequest({ extra: 1, language: "en", term: "word" })).toThrow();
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
