import { voiceCaptureFailureCodes } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { resolveVoiceCaptureFailure } from "./voiceCaptureFailure";

describe("resolveVoiceCaptureFailure", () => {
  it("resolves a non-failed capture (null reason) to no failure", () => {
    expect(resolveVoiceCaptureFailure(null)).toBeNull();
  });

  it.each(voiceCaptureFailureCodes)(
    "passes through the stable stored code %s and derives its retryability",
    (code) => {
      const failure = resolveVoiceCaptureFailure(code);
      expect(failure?.code).toBe(code);
      // `retryable` is always derived from the code, never read from storage.
      const retryable = code === "voice_setup_required" || code === "transcription_failed";
      expect(failure?.retryable).toBe(retryable);
    }
  );

  it("maps the legacy `empty_transcript` sentinel to no_speech", () => {
    expect(resolveVoiceCaptureFailure("empty_transcript")).toEqual({
      code: "no_speech",
      retryable: false
    });
  });

  it("maps the legacy `missing_audio` sentinel to recording_missing", () => {
    expect(resolveVoiceCaptureFailure("missing_audio")).toEqual({
      code: "recording_missing",
      retryable: false
    });
  });

  it("maps any other legacy or raw stored string to a retryable transcription_failed", () => {
    // Older rows may hold a free-form adapter message; fail safe to the retryable generic category.
    expect(resolveVoiceCaptureFailure("Error: model backend unavailable")).toEqual({
      code: "transcription_failed",
      retryable: true
    });
  });
});
