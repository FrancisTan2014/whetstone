import { describe, expect, it } from "vitest";

import {
  defaultPreferences,
  parsePreferences,
  parseUpsertPreferencesRequest
} from "./preferencesContracts.js";

describe("preferences contracts", () => {
  it("defaults to medium day", () => {
    expect(defaultPreferences).toEqual({ readingSize: "md", theme: "day" });
  });

  it("accepts a valid record and round-trips the upsert request", () => {
    expect(parsePreferences({ readingSize: "lg", theme: "night" })).toEqual({
      readingSize: "lg",
      theme: "night"
    });
    expect(parseUpsertPreferencesRequest({ readingSize: "xl", theme: "day" })).toEqual({
      readingSize: "xl",
      theme: "day"
    });
  });

  it("rejects an unknown size, theme, or extra key", () => {
    expect(() => parsePreferences({ readingSize: "huge", theme: "day" })).toThrow();
    expect(() => parsePreferences({ readingSize: "md", theme: "sepia" })).toThrow();
    expect(() => parsePreferences({ extra: 1, readingSize: "md", theme: "day" })).toThrow();
  });
});
