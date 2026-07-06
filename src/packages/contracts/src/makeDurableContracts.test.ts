import { describe, expect, it } from "vitest";

import {
  captureInputModes,
  captureSources,
  parseCreateProposalCandidateRequest,
  parseCreateTimelineCaptureRequest,
  parseProposalCandidateDto,
  parseProposalReviewDto,
  parseRecordProposalReviewRequest,
  parseTimelineCaptureDto,
  proposalCandidateStatuses,
  proposalCandidateTypes,
  proposalDuplicateStatuses,
  proposalReviewOutcomes
} from "./makeDurableContracts.js";

describe("createTimelineCaptureRequest", () => {
  it("defaults input mode and capture source for a bare quick capture", () => {
    expect(parseCreateTimelineCaptureRequest({ rawInputText: "the deploy failed" })).toEqual({
      captureSource: "quick_capture",
      inputMode: "typed",
      rawInputText: "the deploy failed"
    });
  });

  it("accepts explicit mode, source, and optional tidy/language/audio fields", () => {
    const request = {
      captureSource: "diary" as const,
      inputMode: "voice" as const,
      language: "en",
      rawAudioPath: "audio/1.webm",
      rawInputText: "um the thing broke",
      tidiedText: "the thing broke"
    };
    expect(parseCreateTimelineCaptureRequest(request)).toEqual(request);
  });

  it("rejects a blank raw input, an unknown source, and unknown fields", () => {
    expect(() => parseCreateTimelineCaptureRequest({ rawInputText: "   " })).toThrow();
    expect(() =>
      parseCreateTimelineCaptureRequest({ captureSource: "sms", rawInputText: "x" })
    ).toThrow();
    expect(() =>
      parseCreateTimelineCaptureRequest({ rawInputText: "x", userId: "u" })
    ).toThrow();
  });

  it.each(captureInputModes)("accepts input mode %s", (inputMode) => {
    expect(parseCreateTimelineCaptureRequest({ inputMode, rawInputText: "x" }).inputMode).toBe(
      inputMode
    );
  });

  it.each(captureSources)("accepts capture source %s", (captureSource) => {
    expect(
      parseCreateTimelineCaptureRequest({ captureSource, rawInputText: "x" }).captureSource
    ).toBe(captureSource);
  });
});

describe("timelineCaptureDto", () => {
  it("round-trips a capture DTO", () => {
    const dto = {
      captureSource: "quick_capture" as const,
      createdAt: "2026-07-06T09:30:00.000Z",
      entryDate: "2026-07-06",
      entryId: "entry-1",
      inputMode: "typed" as const,
      language: null,
      rawAudioPath: null,
      rawInputText: "the deploy failed",
      tidiedText: null
    };
    expect(parseTimelineCaptureDto(dto)).toEqual(dto);
  });
});

describe("createProposalCandidateRequest", () => {
  const base = {
    confidence: 0.9,
    evidenceQuote: "back up now",
    modelName: "llama3",
    payload: { target: "WorkInsight is back up now" },
    promptVersion: "proposal-v1",
    reason: "reusable phrase",
    timelineEntryId: "entry-1",
    type: "phrase_chunk" as const
  };

  it("defaults status to pending and duplicate status to unique", () => {
    expect(parseCreateProposalCandidateRequest(base)).toEqual({
      ...base,
      duplicateStatus: "unique",
      status: "pending"
    });
  });

  it("rejects an out-of-range confidence and an unknown type", () => {
    expect(() => parseCreateProposalCandidateRequest({ ...base, confidence: 1.5 })).toThrow();
    expect(() => parseCreateProposalCandidateRequest({ ...base, type: "grammar" })).toThrow();
  });

  it.each(proposalCandidateTypes)("accepts type %s", (type) => {
    expect(parseCreateProposalCandidateRequest({ ...base, type }).type).toBe(type);
  });

  it.each(proposalCandidateStatuses)("accepts status %s", (status) => {
    expect(parseCreateProposalCandidateRequest({ ...base, status }).status).toBe(status);
  });

  it.each(proposalDuplicateStatuses)("accepts duplicate status %s", (duplicateStatus) => {
    expect(
      parseCreateProposalCandidateRequest({ ...base, duplicateStatus }).duplicateStatus
    ).toBe(duplicateStatus);
  });
});

describe("proposalCandidateDto", () => {
  it("round-trips a candidate DTO", () => {
    const dto = {
      confidence: 0.9,
      createdAt: "2026-07-06T10:00:00.000Z",
      duplicateStatus: "unique" as const,
      evidenceQuote: "back up now",
      id: "cand-1",
      modelName: "llama3",
      noveltyReason: null,
      payload: { target: "WorkInsight is back up now" },
      promptVersion: "proposal-v1",
      reason: "reusable phrase",
      relatedRecallItemId: null,
      status: "pending" as const,
      timelineEntryId: "entry-1",
      type: "phrase_chunk" as const
    };
    expect(parseProposalCandidateDto(dto)).toEqual(dto);
  });
});

describe("recordProposalReviewRequest", () => {
  it("accepts a bare save outcome", () => {
    expect(
      parseRecordProposalReviewRequest({ outcome: "saved", proposalCandidateId: "cand-1" })
    ).toEqual({ outcome: "saved", proposalCandidateId: "cand-1" });
  });

  it("accepts feedback tags and an edited payload", () => {
    const request = {
      editedPayload: { target: "It's back up now" },
      feedbackTags: ["reworded"],
      outcome: "edited_saved" as const,
      proposalCandidateId: "cand-1"
    };
    expect(parseRecordProposalReviewRequest(request)).toEqual(request);
  });

  it("rejects an unknown outcome and a blank feedback tag", () => {
    expect(() =>
      parseRecordProposalReviewRequest({ outcome: "maybe", proposalCandidateId: "cand-1" })
    ).toThrow();
    expect(() =>
      parseRecordProposalReviewRequest({
        feedbackTags: [" "],
        outcome: "saved",
        proposalCandidateId: "cand-1"
      })
    ).toThrow();
  });

  it.each(proposalReviewOutcomes)("accepts outcome %s", (outcome) => {
    expect(
      parseRecordProposalReviewRequest({ outcome, proposalCandidateId: "cand-1" }).outcome
    ).toBe(outcome);
  });
});

describe("proposalReviewDto", () => {
  it("round-trips a review DTO", () => {
    const dto = {
      createdAt: "2026-07-07T08:00:00.000Z",
      editedPayload: null,
      feedbackTags: null,
      id: "review-1",
      outcome: "saved" as const,
      proposalCandidateId: "cand-1"
    };
    expect(parseProposalReviewDto(dto)).toEqual(dto);
  });
});
