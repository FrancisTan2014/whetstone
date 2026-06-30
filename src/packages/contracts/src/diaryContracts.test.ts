import { describe, expect, it } from "vitest";

import {
  diaryCalendarQuerySchema,
  parseCreateDiaryEntryRequest,
  parseDiaryCalendarDto,
  parseDiaryEntryDto,
  parseTimelineDto,
  parseUpdateDiaryEntryRequest,
  timelineQuerySchema
} from "./diaryContracts.js";

describe("parseCreateDiaryEntryRequest", () => {
  it("accepts a non-blank transcript", () => {
    expect(parseCreateDiaryEntryRequest({ transcript: "today I read a book" })).toEqual({
      transcript: "today I read a book"
    });
  });

  it("rejects a blank transcript", () => {
    expect(() => parseCreateDiaryEntryRequest({ transcript: "   " })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseCreateDiaryEntryRequest({ extra: 1, transcript: "x" })).toThrow();
  });
});

describe("parseUpdateDiaryEntryRequest", () => {
  it("accepts a non-blank text", () => {
    expect(parseUpdateDiaryEntryRequest({ text: "edited" })).toEqual({ text: "edited" });
  });

  it("rejects a blank text", () => {
    expect(() => parseUpdateDiaryEntryRequest({ text: "" })).toThrow();
  });
});

describe("parseDiaryEntryDto", () => {
  it("accepts an entry with a null language", () => {
    const dto = {
      createdAt: "2026-06-30T20:38:00.000Z",
      entryDate: "2026-06-30",
      id: "diary-1",
      language: null,
      text: "I went to the park."
    };
    expect(parseDiaryEntryDto(dto)).toEqual(dto);
  });

  it("accepts an entry with a free-form language", () => {
    const dto = {
      createdAt: "2026-06-30T20:38:00.000Z",
      entryDate: "2026-06-30",
      id: "diary-2",
      language: "zh",
      text: "今天我去了公园。"
    };
    expect(parseDiaryEntryDto(dto)).toEqual(dto);
  });

  it("rejects a malformed entryDate", () => {
    expect(() =>
      parseDiaryEntryDto({
        createdAt: "2026-06-30T20:38:00.000Z",
        entryDate: "2026/06/30",
        id: "diary-3",
        language: null,
        text: "x"
      })
    ).toThrow();
  });
});

describe("parseTimelineDto", () => {
  it("accepts day-grouped diary entries", () => {
    const dto = {
      days: [
        {
          date: "2026-06-30",
          entries: [
            {
              createdAt: "2026-06-30T20:38:00.000Z",
              id: "diary-1",
              kind: "diary",
              language: null,
              text: "I went to the park."
            }
          ]
        }
      ]
    };
    expect(parseTimelineDto(dto)).toEqual(dto);
  });

  it("accepts an empty page", () => {
    expect(parseTimelineDto({ days: [] })).toEqual({ days: [] });
  });

  it("rejects an unknown entry kind", () => {
    expect(() =>
      parseTimelineDto({
        days: [
          {
            date: "2026-06-30",
            entries: [
              {
                createdAt: "2026-06-30T20:38:00.000Z",
                id: "x",
                kind: "note",
                language: null,
                text: "x"
              }
            ]
          }
        ]
      })
    ).toThrow();
  });
});

describe("parseDiaryCalendarDto", () => {
  it("accepts a list of marked dates", () => {
    expect(parseDiaryCalendarDto({ dates: ["2026-06-29", "2026-06-30"] })).toEqual({
      dates: ["2026-06-29", "2026-06-30"]
    });
  });

  it("rejects a malformed date", () => {
    expect(() => parseDiaryCalendarDto({ dates: ["June 30"] })).toThrow();
  });
});

describe("timelineQuerySchema", () => {
  it("coerces a string limit and a before cursor", () => {
    expect(timelineQuerySchema.parse({ before: "2026-06-30", limit: "7" })).toEqual({
      before: "2026-06-30",
      limit: 7
    });
  });

  it("accepts an empty query (first page, default limit applied by the route)", () => {
    expect(timelineQuerySchema.parse({})).toEqual({});
  });

  it("rejects a non-positive limit", () => {
    expect(() => timelineQuerySchema.parse({ limit: "0" })).toThrow();
  });

  it("rejects a malformed before cursor", () => {
    expect(() => timelineQuerySchema.parse({ before: "yesterday" })).toThrow();
  });
});

describe("diaryCalendarQuerySchema", () => {
  it("accepts a from/to day-key range", () => {
    expect(diaryCalendarQuerySchema.parse({ from: "2026-06-01", to: "2026-06-30" })).toEqual({
      from: "2026-06-01",
      to: "2026-06-30"
    });
  });

  it("requires both bounds", () => {
    expect(() => diaryCalendarQuerySchema.parse({ from: "2026-06-01" })).toThrow();
  });
});
