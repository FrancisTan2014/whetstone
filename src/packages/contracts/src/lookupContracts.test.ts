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

  it("rejects a non-English language", () => {
    expect(() => parseLookupRequest({ language: "fr", term: "bonjour" })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseLookupRequest({ extra: 1, language: "en", term: "word" })).toThrow();
  });
});

describe("parseLookupResponse", () => {
  it("accepts a found entry with attribution", () => {
    const response = {
      attribution: "Source.",
      entry: {
        headword: "word",
        pronunciation: "wərd",
        senses: [{ example: "a kind word", gloss: "a unit of language", partOfSpeech: "noun" }]
      },
      found: true
    };

    expect(parseLookupResponse(response)).toEqual(response);
  });

  it("accepts a found entry without optional fields", () => {
    const response = { entry: { headword: "word", senses: [{ gloss: "meaning" }] }, found: true };

    expect(parseLookupResponse(response)).toEqual(response);
  });

  it("accepts an explicit not-found result", () => {
    expect(parseLookupResponse({ found: false })).toEqual({ found: false });
  });

  it("rejects a found result missing its entry", () => {
    expect(lookupResponseSchema.safeParse({ found: true }).success).toBe(false);
  });
});
