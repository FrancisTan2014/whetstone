import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  documentJsonSchema,
  parseCreateDiaryEntryRequest,
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
  it("accepts a body document (typed capture is server-owned, no input mode or language, #678)", () => {
    expect(parseCreateDiaryEntryRequest({ bodyDoc })).toEqual({ bodyDoc });
  });

  it("preserves a multi-block rich document byte-for-byte (#678)", () => {
    const richDoc = {
      content: [
        { content: [{ text: "Title", type: "text" }], type: "heading" },
        { content: [{ text: "body", type: "text" }], type: "paragraph" }
      ],
      type: "doc"
    };
    expect(parseCreateDiaryEntryRequest({ bodyDoc: richDoc })).toEqual({ bodyDoc: richDoc });
  });

  it("rejects a document with no readable text (only empty structural nodes, #678)", () => {
    expect(() =>
      parseCreateDiaryEntryRequest({ bodyDoc: { content: [{ type: "paragraph" }], type: "doc" } })
    ).toThrow();
  });

  it("rejects a malformed body document", () => {
    expect(() =>
      parseCreateDiaryEntryRequest({ bodyDoc: { content: [{ type: "bogus" }], type: "doc" } })
    ).toThrow();
  });

  it("no longer accepts the legacy transcript/inputMode shape (#678)", () => {
    expect(() =>
      parseCreateDiaryEntryRequest({ inputMode: "typed", transcript: "today I read a book" })
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseCreateDiaryEntryRequest({ bodyDoc, extra: 1 })).toThrow();
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
    hasAudio: false,
    id: "diary-1",
    inputMode: "typed" as const,
    language: null,
    occurredAt: "2026-06-30T20:38:00.000Z",
    processingStatus: null,
    transcript: null,
    updatedAt: "2026-06-30T20:38:00.000Z"
  };

  it("accepts a synchronous typed entry (null processing status)", () => {
    expect(parseDiaryEntryDto(base)).toEqual(base);
  });

  it("accepts a ready voice entry carrying its retained transcript and audio flag (#801)", () => {
    const dto = {
      ...base,
      hasAudio: true,
      id: "diary-9",
      inputMode: "voice" as const,
      language: "en",
      processingStatus: "ready" as const,
      transcript: "  today I read a book  "
    };
    expect(parseDiaryEntryDto(dto)).toEqual(dto);
  });

  it("rejects a non-boolean hasAudio", () => {
    expect(() => parseDiaryEntryDto({ ...base, hasAudio: "yes" })).toThrow();
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

  it("accepts a failed voice entry (failure detail lives on the voice-capture DTO, not here)", () => {
    const dto = {
      ...base,
      inputMode: "voice" as const,
      processingStatus: "failed" as const
    };
    expect(parseDiaryEntryDto(dto)).toEqual(dto);
  });

  it("rejects a stray failureReason field (failure detail is not carried on a diary entry)", () => {
    expect(() => parseDiaryEntryDto({ ...base, failureReason: "model unavailable" })).toThrow();
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
      inputMode: "typed" as const,
      kind: "diary" as const,
      language: null,
      occurredAt: "2026-06-30T20:38:00.000Z"
    };
    expect(parseTimelineEntryDto(dto)).toEqual(dto);
  });

  it("rejects a diary timeline row missing inputMode (#801)", () => {
    expect(() =>
      parseTimelineEntryDto({
        bodyDoc,
        bodyText: "x",
        entryId: "diary-1",
        kind: "diary",
        language: null,
        occurredAt: "2026-06-30T20:38:00.000Z"
      })
    ).toThrow();
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
              inputMode: "typed" as const,
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
