import type { VoiceCaptureStatus } from "@whetstone/contracts";

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
