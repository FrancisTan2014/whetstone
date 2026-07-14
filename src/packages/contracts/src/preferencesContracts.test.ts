import { describe, expect, it } from "vitest";

import {
  defaultPreferences,
  parsePreferences,
  parseStoredPreferences,
  parseUpsertPreferencesRequest
} from "./preferencesContracts.js";

describe("preferences contracts", () => {
  it("defaults to medium day in UTC", () => {
    expect(defaultPreferences).toEqual({ readingSize: "md", theme: "day", timeZone: "UTC" });
  });

  it("accepts a valid record and round-trips the upsert request", () => {
    expect(
      parsePreferences({ readingSize: "lg", theme: "night", timeZone: "America/New_York" })
    ).toEqual({
      readingSize: "lg",
      theme: "night",
      timeZone: "America/New_York"
    });
    expect(
      parseUpsertPreferencesRequest({ readingSize: "xl", theme: "day", timeZone: "Asia/Shanghai" })
    ).toEqual({
      readingSize: "xl",
      theme: "day",
      timeZone: "Asia/Shanghai"
    });
  });

  it("rejects an unknown size, theme, timezone, or extra key", () => {
    expect(() =>
      parsePreferences({ readingSize: "huge", theme: "day", timeZone: "UTC" })
    ).toThrow();
    expect(() =>
      parsePreferences({ readingSize: "md", theme: "sepia", timeZone: "UTC" })
    ).toThrow();
    expect(() =>
      parsePreferences({ readingSize: "md", theme: "day", timeZone: "Not/AZone" })
    ).toThrow();
    expect(() =>
      parsePreferences({ extra: 1, readingSize: "md", theme: "day", timeZone: "UTC" })
    ).toThrow();
  });

  it("requires timeZone on a save", () => {
    expect(() => parsePreferences({ readingSize: "md", theme: "day" })).toThrow();
  });

  it("allows a null timeZone on the stored record until first-use defaulting persists a zone", () => {
    expect(parseStoredPreferences({ readingSize: "md", theme: "day", timeZone: null })).toEqual({
      readingSize: "md",
      theme: "day",
      timeZone: null
    });
    expect(
      parseStoredPreferences({ readingSize: "sm", theme: "night", timeZone: "Europe/Paris" })
    ).toEqual({
      readingSize: "sm",
      theme: "night",
      timeZone: "Europe/Paris"
    });
  });

  it("still rejects an invalid non-null timeZone on the stored record", () => {
    expect(() =>
      parseStoredPreferences({ readingSize: "md", theme: "day", timeZone: "Not/AZone" })
    ).toThrow();
  });
});
