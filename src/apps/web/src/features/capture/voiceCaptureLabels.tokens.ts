import type { VoiceCaptureFailureCode, VoiceCaptureStatus } from "@whetstone/contracts";

// Pure enum→copy maps for a pending voice capture's status, kept out of the coverage floor per the
// testing rubric (a test restating these constants proves nothing). The status text is calm and
// non-technical — it never names the model/provider (#566): a queued clip is simply "saved and waiting".
export const voiceCaptureStatusLabels: Readonly<Record<VoiceCaptureStatus, string>> = {
  queued: "Saved — waiting to transcribe…",
  transcribing: "Transcribing…",
  tidying: "Tidying up…",
  ready: "Ready",
  failed: "Couldn't transcribe — your recording is safe."
};

// Category-specific, actionable copy for a failed voice capture (#675). Each line explains what happened
// in plain language and names the concrete next step for that category, never raw adapter/process detail.
// A pure, total map over the stable failure codes, so it lives in this coverage-excluded tokens module;
// which code a failure has (and whether it is retryable) is decided server-side.
export const voiceCaptureFailureCopy: Readonly<Record<VoiceCaptureFailureCode, string>> = {
  no_speech: "No speech was detected. Check your microphone and record the entry again.",
  voice_setup_required:
    "Voice transcription isn't set up. Run `pnpm setup:voice`, then retry transcription.",
  transcription_failed:
    "Transcription failed. Your recording is safe. Run `pnpm setup:doctor`, then retry transcription.",
  recording_missing: "The saved recording could not be found. Record this entry again."
};
