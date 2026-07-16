import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  diaryCalendarQuerySchema,
  documentJsonSchema,
  parseCreateDiaryEntryRequest,
  parseDiaryCalendarDto,
  parseDiaryEntryDto,
  parseTimelineDto,
  parseTimelineEntryDto,
  parseUpdateDiaryEntryRequest,
  timelineEntryDtoKinds,
  timelineQuerySchema
} from "./diaryContracts.js";

const bodyDoc = createTextDocument("I went to the park.");
const otherDoc = createTextDocument("edited body");

describe("documentJsonSchema", () => {
  it("accepts a valid document and rejects a malformed one", () => {
    expect(documentJsonSchema.safeParse(bodyDoc).success).toBe(true);
    expect(
      documentJsonSchema.safeParse({ type: "doc", content: [{ type: "bogus" }] }).success
    ).toBe(false);
    expect(documentJsonSchema.safeParse("not a doc").success).toBe(false);
  });
});

describe("parseCreateDiaryEntryRequest", () => {
  it("accepts a non-blank transcript with an input mode (no capture language, #647)", () => {
    expect(
      parseCreateDiaryEntryRequest({
        inputMode: "typed",
        transcript: "today I read a book"
      })
    ).toEqual({ inputMode: "typed", transcript: "today I read a book" });
  });

  it("rejects a blank transcript", () => {
    expect(() => parseCreateDiaryEntryRequest({ inputMode: "voice", transcript: "   " })).toThrow();
  });

  it("rejects a missing or invalid input mode", () => {
    expect(() => parseCreateDiaryEntryRequest({ transcript: "x" })).toThrow();
    expect(() =>
      parseCreateDiaryEntryRequest({ inputMode: "handwritten", transcript: "x" })
    ).toThrow();
  });

  it("no longer accepts a capture language: a language key is rejected (#647)", () => {
    expect(() =>
      parseCreateDiaryEntryRequest({ inputMode: "typed", language: "en", transcript: "x" })
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      parseCreateDiaryEntryRequest({
        extra: 1,
        inputMode: "typed",
        transcript: "x"
      })
    ).toThrow();
  });
});

describe("parseUpdateDiaryEntryRequest", () => {
  it("accepts a rich body document with an optional language", () => {
    expect(parseUpdateDiaryEntryRequest({ bodyDoc: otherDoc, language: "en" })).toEqual({
      bodyDoc: otherDoc,
      language: "en"
    });
  });

  it("accepts a body document without a language", () => {
    expect(parseUpdateDiaryEntryRequest({ bodyDoc: otherDoc })).toEqual({ bodyDoc: otherDoc });
  });

  it("rejects a malformed body document", () => {
    expect(() =>
      parseUpdateDiaryEntryRequest({ bodyDoc: { type: "doc", content: [{ type: "bogus" }] } })
    ).toThrow();
  });

  it("rejects an unsupported language", () => {
    expect(() => parseUpdateDiaryEntryRequest({ bodyDoc: otherDoc, language: "fr" })).toThrow();
  });
});

describe("parseDiaryEntryDto", () => {
  const base = {
    bodyDoc,
    bodyText: "I went to the park.",
    createdAt: "2026-06-30T20:38:00.000Z",
    failureReason: null,
    id: "diary-1",
    inputMode: "typed" as const,
    language: null,
    occurredAt: "2026-06-30T20:38:00.000Z",
    processingStatus: null,
    updatedAt: "2026-06-30T20:38:00.000Z"
  };

  it("accepts a synchronous typed entry (null processing status)", () => {
    expect(parseDiaryEntryDto(base)).toEqual(base);
  });

  it("accepts a queued voice entry with a processing status and language", () => {
    const dto = {
      ...base,
      id: "diary-2",
      inputMode: "voice" as const,
      language: "zh",
      processingStatus: "queued" as const
    };
    expect(parseDiaryEntryDto(dto)).toEqual(dto);
  });

  it("accepts a failed entry with a failure reason", () => {
    const dto = {
      ...base,
      failureReason: "model unavailable",
      processingStatus: "failed" as const
    };
    expect(parseDiaryEntryDto(dto)).toEqual(dto);
  });

  it("rejects an invalid processing status", () => {
    expect(() => parseDiaryEntryDto({ ...base, processingStatus: "done" })).toThrow();
  });

  it("rejects a malformed body document", () => {
    expect(() =>
      parseDiaryEntryDto({ ...base, bodyDoc: { type: "doc", content: [{ type: "bogus" }] } })
    ).toThrow();
  });
});

describe("parseTimelineEntryDto", () => {
  it("accepts a diary entry", () => {
    const dto = {
      bodyDoc,
      bodyText: "I went to the park.",
      entryId: "diary-1",
      kind: "diary" as const,
      language: null,
      occurredAt: "2026-06-30T20:38:00.000Z"
    };
    expect(parseTimelineEntryDto(dto)).toEqual(dto);
  });

  it("accepts a note entry with its capture source and prompt count", () => {
    const dto = {
      captureSource: "reader" as const,
      entryId: "note-1",
      kind: "note" as const,
      occurredAt: "2026-06-29T10:00:00.000Z",
      promptCount: 0,
      text: "a note body"
    };
    expect(parseTimelineEntryDto(dto)).toEqual(dto);
  });

  it("accepts a former Memory note as a note entry carrying its capture source and prompt count", () => {
    const dto = {
      captureSource: "manual" as const,
      entryId: "mem-1",
      kind: "note" as const,
      occurredAt: "2026-06-28T10:00:00.000Z",
      promptCount: 2,
      text: "遠慮 — to hold back out of consideration"
    };
    expect(parseTimelineEntryDto(dto)).toEqual(dto);
  });

  it("accepts an authored-work entry", () => {
    const dto = {
      entryId: "work-1",
      kind: "work" as const,
      occurredAt: "2026-06-28T10:00:00.000Z",
      title: "My essay",
      workEntryId: "work-1"
    };
    expect(parseTimelineEntryDto(dto)).toEqual(dto);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      parseTimelineEntryDto({ entryId: "x", kind: "highlight", occurredAt: "x", text: "y" })
    ).toThrow();
  });
});

describe("timelineEntryDtoKinds", () => {
  it("matches the diary, note, work, and recitation discriminants", () => {
    expect(timelineEntryDtoKinds).toEqual(["diary", "note", "work", "recitation"]);
  });
});

describe("parseTimelineDto", () => {
  it("accepts a day-grouped page mixing diary and note entries", () => {
    const dto = {
      days: [
        {
          date: "2026-06-30",
          entries: [
            {
              bodyDoc,
              bodyText: "I went to the park.",
              entryId: "diary-1",
              kind: "diary" as const,
              language: null,
              occurredAt: "2026-06-30T20:38:00.000Z"
            },
            {
              captureSource: "reader" as const,
              entryId: "note-1",
              kind: "note" as const,
              occurredAt: "2026-06-30T09:00:00.000Z",
              promptCount: 0,
              text: "a note"
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

  it("rejects a malformed day key", () => {
    expect(() => parseTimelineDto({ days: [{ date: "2026/06/30", entries: [] }] })).toThrow();
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

  it("accepts an empty query", () => {
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
