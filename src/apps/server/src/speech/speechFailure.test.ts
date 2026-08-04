import { describe, expect, it } from "vitest";

import { classifyEmptyTranscript } from "./speechFailure.js";

describe("classifyEmptyTranscript", () => {
  it("treats an empty transcript from a configured speech engine as genuine silence", () => {
    // A configured Whisper produced no words → the learner simply did not speak.
    expect(classifyEmptyTranscript(true)).toBe("no_speech");
  });

  it("treats an empty transcript with no speech engine configured as a setup gap", () => {
    // The deterministic fake (no WHISPER_* env) can never transcribe, so an empty result points the
    // learner at `pnpm setup:voice` rather than blaming their microphone.
    expect(classifyEmptyTranscript(false)).toBe("voice_setup_required");
  });
});
