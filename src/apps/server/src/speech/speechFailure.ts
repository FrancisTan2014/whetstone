import type { VoiceCaptureFailureCode } from "@whetstone/contracts";

// The speech boundary's typed failure categorization. The voice-capture worker delegates here instead of
// inspecting adapter/process error strings, so knowledge of what a speech outcome *means* lives with the
// speech seam (not scattered across the worker or the browser). An empty transcript means one of two
// things depending on whether local speech-to-text is configured on this machine: with a configured
// Whisper it is a genuine silence (`no_speech`); on the deterministic fake (no WHISPER_* env) it is the
// unconfigured path (`voice_setup_required`), which pointing the learner at `pnpm setup:voice` fixes.
export function classifyEmptyTranscript(speechConfigured: boolean): VoiceCaptureFailureCode {
  return speechConfigured ? "no_speech" : "voice_setup_required";
}
