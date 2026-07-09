import { describe, expect, it } from "vitest";

import {
  parseVoiceCaptureAcceptedDto,
  parseVoiceCaptureStatusDto
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

describe("parseVoiceCaptureStatusDto", () => {
  const ready = {
    createdAt: "2026-07-09T10:00:00.000Z",
    entryDate: "2026-07-09",
    failureReason: null,
    id: "cap-1",
    language: "en" as const,
    status: "ready" as const,
    text: "the deploy is green"
  };

  it("round-trips a ready capture", () => {
    expect(parseVoiceCaptureStatusDto(ready)).toEqual(ready);
  });

  it("round-trips a failed capture with a reason and no text", () => {
    const failed = {
      ...ready,
      status: "failed" as const,
      failureReason: "empty_transcript",
      language: null,
      text: null
    };
    expect(parseVoiceCaptureStatusDto(failed)).toEqual(failed);
  });

  it("rejects a malformed entry date", () => {
    expect(() => parseVoiceCaptureStatusDto({ ...ready, entryDate: "2026-7-9" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => parseVoiceCaptureStatusDto({ ...ready, status: "processing" })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => parseVoiceCaptureStatusDto({ ...ready, extra: true })).toThrow();
  });
});
