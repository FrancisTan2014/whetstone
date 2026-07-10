import { describe, expect, it } from "vitest";

import {
  dueRecitationPassageResponseSchema,
  parseDueRecitationPassageResponse,
  parseRecitationPassageListDto,
  parseRecordRecitationReviewRequest,
  parseRecordRecitationReviewResponse,
  parseSplitRecitationPassageRequest,
  recitationPassageDtoSchema,
  recordRecitationReviewRequestSchema,
  splitRecitationPassageRequestSchema
} from "./recitationPassageContracts.js";

const passage = {
  anchorStatus: "anchored" as const,
  dueAt: "2026-07-01T09:00:00.000Z",
  endBlockEntryId: "b1",
  endOffset: 10,
  entryId: "passage-1",
  lapses: 0,
  lastReviewedAt: null,
  orderIndex: 0,
  planEntryId: "plan-1",
  reps: 0,
  reviewCount: 0,
  sourceText: "Alpha beta",
  startBlockEntryId: "b1",
  startOffset: 0
};

describe("recitationPassageDtoSchema", () => {
  it("accepts a well-formed passage", () => {
    expect(recitationPassageDtoSchema.parse(passage)).toEqual(passage);
  });

  it("rejects an unknown anchor status", () => {
    expect(
      recitationPassageDtoSchema.safeParse({ ...passage, anchorStatus: "broken" }).success
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(recitationPassageDtoSchema.safeParse({ ...passage, extra: 1 }).success).toBe(false);
  });
});

describe("parseRecitationPassageListDto", () => {
  it("accepts a plan's passage list", () => {
    expect(parseRecitationPassageListDto({ passages: [passage], planEntryId: "plan-1" })).toEqual({
      passages: [passage],
      planEntryId: "plan-1"
    });
  });
});

describe("parseSplitRecitationPassageRequest", () => {
  it("accepts a block and offset", () => {
    expect(parseSplitRecitationPassageRequest({ atBlockEntryId: "b1", atOffset: 5 })).toEqual({
      atBlockEntryId: "b1",
      atOffset: 5
    });
  });

  it("rejects a blank block id", () => {
    expect(
      splitRecitationPassageRequestSchema.safeParse({ atBlockEntryId: " ", atOffset: 5 }).success
    ).toBe(false);
  });

  it("rejects a negative offset", () => {
    expect(
      splitRecitationPassageRequestSchema.safeParse({ atBlockEntryId: "b1", atOffset: -1 }).success
    ).toBe(false);
  });
});

describe("dueRecitationPassageResponseSchema", () => {
  it("accepts a due passage", () => {
    const response = {
      passage: {
        anchorStatus: "anchored" as const,
        context: "Aesop’s Fables",
        defaultCueStrength: "preceding_line" as const,
        passageEntryId: "passage-1",
        planEntryId: "plan-1",
        precedingText: "the line before",
        targetText: "Alpha beta",
        workTitle: "Aesop’s Fables"
      }
    };
    expect(parseDueRecitationPassageResponse(response)).toEqual(response);
  });

  it("accepts a null due passage (nothing due)", () => {
    expect(dueRecitationPassageResponseSchema.parse({ passage: null })).toEqual({ passage: null });
  });

  it("accepts a first passage with no preceding text", () => {
    const response = {
      passage: {
        anchorStatus: "needs_repair" as const,
        context: "ctx",
        defaultCueStrength: "opening" as const,
        passageEntryId: "p",
        planEntryId: "plan",
        precedingText: null,
        targetText: "t",
        workTitle: "w"
      }
    };
    expect(parseDueRecitationPassageResponse(response)).toEqual(response);
  });
});

describe("parseRecordRecitationReviewRequest", () => {
  it("accepts a rating and cue strength", () => {
    expect(parseRecordRecitationReviewRequest({ cueStrength: "opening", rating: "good" })).toEqual({
      cueStrength: "opening",
      rating: "good"
    });
  });

  it("rejects an unknown rating", () => {
    expect(
      recordRecitationReviewRequestSchema.safeParse({ cueStrength: "opening", rating: "meh" })
        .success
    ).toBe(false);
  });

  it("rejects an unknown cue strength", () => {
    expect(
      recordRecitationReviewRequestSchema.safeParse({ cueStrength: "full", rating: "good" }).success
    ).toBe(false);
  });
});

describe("parseRecordRecitationReviewResponse", () => {
  it("accepts an updated passage", () => {
    expect(parseRecordRecitationReviewResponse({ passage })).toEqual({ passage });
  });
});
