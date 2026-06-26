import { describe, expect, it } from "vitest";

import {
  parseSearchRequest,
  parseSearchResults,
  searchRequestSchema,
  type SearchResultsDto
} from "./searchContracts.js";

describe("searchRequestSchema", () => {
  it("trims the query and keeps the cleaned value", () => {
    expect(parseSearchRequest({ q: "  dog  " })).toEqual({ q: "dog" });
  });

  it("rejects a blank or empty query", () => {
    expect(searchRequestSchema.safeParse({ q: "   " }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ q: "" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(searchRequestSchema.safeParse({ extra: 1, q: "dog" }).success).toBe(false);
  });
});

describe("searchResultsDtoSchema", () => {
  it("parses a well-formed results payload", () => {
    const payload: SearchResultsDto = {
      query: "dog",
      results: [
        {
          authorName: "George Orwell",
          blockEntryId: "block-1",
          plaintext: "The dog barked.",
          workEntryId: "work-1",
          workTitle: "Animal Farm"
        }
      ]
    };

    expect(parseSearchResults(payload)).toEqual(payload);
  });

  it("accepts an empty result set", () => {
    expect(parseSearchResults({ query: "dog", results: [] })).toEqual({
      query: "dog",
      results: []
    });
  });

  it("throws when a result is missing a field", () => {
    expect(() =>
      parseSearchResults({
        query: "dog",
        results: [{ authorName: "A", blockEntryId: "b", workEntryId: "w", workTitle: "t" }]
      })
    ).toThrow();
  });
});
