import { describe, expect, it } from "vitest";

import {
  isRetryableVoiceCaptureFailure,
  makeVoiceCaptureFailure,
  parseRecordedAudioContentType,
  parseVoiceCaptureAcceptedDto,
  parseVoiceCaptureListDto,
  parseVoiceCaptureStatusDto,
  recordedAudioContentTypes,
  voiceCaptureFailureCodes
} from "./voiceCaptureContracts.js";

describe("parseVoiceCaptureAcceptedDto", () => {
  it("round-trips the pending acceptance response", () => {
    const accepted = { id: "cap-1", status: "queued" as const };
    expect(parseVoiceCaptureAcceptedDto(accepted)).toEqual(accepted);
  });

  it("rejects an unknown status", () => {
    expect(() => parseVoiceCaptureAcceptedDto({ id: "cap-1", status: "done" })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseVoiceCaptureAcceptedDto({ id: "cap-1", status: "queued", extra: true })
    ).toThrow();
  });
});

describe("isRetryableVoiceCaptureFailure", () => {
  it("marks setup-required and transcription failures retryable (the saved audio survives)", () => {
    expect(isRetryableVoiceCaptureFailure("voice_setup_required")).toBe(true);
    expect(isRetryableVoiceCaptureFailure("transcription_failed")).toBe(true);
  });

  it("marks no-speech and missing-recording failures non-retryable (re-transcribing cannot win)", () => {
    expect(isRetryableVoiceCaptureFailure("no_speech")).toBe(false);
    expect(isRetryableVoiceCaptureFailure("recording_missing")).toBe(false);
  });
});

describe("makeVoiceCaptureFailure", () => {
  it("derives retryable from the code so the two can never drift", () => {
    expect(makeVoiceCaptureFailure("voice_setup_required")).toEqual({
      code: "voice_setup_required",
      retryable: true
    });
    expect(makeVoiceCaptureFailure("no_speech")).toEqual({ code: "no_speech", retryable: false });
  });

  it("derives a consistent retryable flag for every known code", () => {
    for (const code of voiceCaptureFailureCodes) {
      expect(makeVoiceCaptureFailure(code).retryable).toBe(isRetryableVoiceCaptureFailure(code));
    }
  });
});

describe("parseVoiceCaptureStatusDto", () => {
  const ready = {
    failure: null,
    id: "cap-1",
    language: "en" as const,
    occurredAt: "2026-07-09T10:00:00.000Z",
    status: "ready" as const,
    text: "the deploy is green"
  };

  it("round-trips a ready capture with no failure", () => {
    expect(parseVoiceCaptureStatusDto(ready)).toEqual(ready);
  });

  it("round-trips a failed capture carrying a category and no text", () => {
    const failed = {
      ...ready,
      failure: { code: "no_speech" as const, retryable: false },
      language: null,
      status: "failed" as const,
      text: null
    };
    expect(parseVoiceCaptureStatusDto(failed)).toEqual(failed);
  });

  it("round-trips a retryable failed capture", () => {
    const failed = {
      ...ready,
      failure: { code: "transcription_failed" as const, retryable: true },
      language: null,
      status: "failed" as const,
      text: null
    };
    expect(parseVoiceCaptureStatusDto(failed)).toEqual(failed);
  });

  it("rejects an unknown failure code", () => {
    expect(() =>
      parseVoiceCaptureStatusDto({
        ...ready,
        failure: { code: "kaboom", retryable: true },
        status: "failed"
      })
    ).toThrow();
  });

  it("rejects a failure missing its retryable flag", () => {
    expect(() =>
      parseVoiceCaptureStatusDto({ ...ready, failure: { code: "no_speech" }, status: "failed" })
    ).toThrow();
  });

  it("rejects a failure carrying unknown fields", () => {
    expect(() =>
      parseVoiceCaptureStatusDto({
        ...ready,
        failure: { code: "no_speech", retryable: false, raw: "stderr" },
        status: "failed"
      })
    ).toThrow();
  });

  it("rejects a missing occurredAt", () => {
    const { occurredAt: _omit, ...withoutOccurredAt } = ready;
    expect(() => parseVoiceCaptureStatusDto(withoutOccurredAt)).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => parseVoiceCaptureStatusDto({ ...ready, status: "processing" })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => parseVoiceCaptureStatusDto({ ...ready, extra: true })).toThrow();
  });
});

describe("parseVoiceCaptureListDto", () => {
  const queued = {
    failure: null,
    id: "cap-1",
    language: "en" as const,
    occurredAt: "2026-07-09T10:00:00.000Z",
    status: "queued" as const,
    text: null
  };

  it("round-trips a list of pending captures", () => {
    const list = {
      captures: [queued, { ...queued, id: "cap-2", status: "transcribing" as const }]
    };
    expect(parseVoiceCaptureListDto(list)).toEqual(list);
  });

  it("round-trips an empty list", () => {
    expect(parseVoiceCaptureListDto({ captures: [] })).toEqual({ captures: [] });
  });

  it("rejects a capture with an unknown status", () => {
    expect(() =>
      parseVoiceCaptureListDto({ captures: [{ ...queued, status: "processing" }] })
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => parseVoiceCaptureListDto({ captures: [], extra: true })).toThrow();
  });
});

describe("parseRecordedAudioContentType", () => {
  it("accepts every allowlisted recorded container as its own essence", () => {
    for (const type of recordedAudioContentTypes) {
      expect(parseRecordedAudioContentType(type)).toBe(type);
    }
  });

  it("normalizes to the lowercased essence, dropping codecs and casing (audio/webm;codecs=opus)", () => {
    expect(parseRecordedAudioContentType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(parseRecordedAudioContentType("AUDIO/WEBM")).toBe("audio/webm");
    expect(parseRecordedAudioContentType("audio/ogg; codecs=opus")).toBe("audio/ogg");
  });

  it("rejects non-audio, octet-stream, empty, and absent values so nothing untrusted is reflected", () => {
    expect(parseRecordedAudioContentType("application/octet-stream")).toBeNull();
    expect(parseRecordedAudioContentType("text/html")).toBeNull();
    expect(parseRecordedAudioContentType("audio/basic")).toBeNull();
    expect(parseRecordedAudioContentType("")).toBeNull();
    expect(parseRecordedAudioContentType(undefined)).toBeNull();
    expect(parseRecordedAudioContentType(null)).toBeNull();
  });
});
