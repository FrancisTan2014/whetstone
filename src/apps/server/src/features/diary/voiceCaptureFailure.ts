import {
  makeVoiceCaptureFailure,
  voiceCaptureFailureCodeSchema,
  type VoiceCaptureFailure,
  type VoiceCaptureFailureCode
} from "@whetstone/contracts";

// Map a persisted `failure_reason` to the client-facing failure category, so an existing `failed` capture
// stays readable without a data migration. New failures store a stable category code; older rows may hold
// a legacy sentinel or a free-form/raw string, all mapped conservatively:
//   - a known stable code passes through;
//   - the legacy `empty_transcript` → `no_speech`;
//   - the legacy `missing_audio`    → `recording_missing`;
//   - anything else (any other legacy or raw string) → `transcription_failed` (fail safe, retryable).
// A null reason (a non-failed capture) yields no failure. `retryable` is derived from the code so the
// stored reason can never carry a stale retry affordance.
const legacyReasonCodes: Readonly<Record<string, VoiceCaptureFailureCode>> = {
  empty_transcript: "no_speech",
  missing_audio: "recording_missing"
};

export function resolveVoiceCaptureFailure(
  storedReason: string | null
): VoiceCaptureFailure | null {
  if (storedReason === null) {
    return null;
  }
  const known = voiceCaptureFailureCodeSchema.safeParse(storedReason);
  if (known.success) {
    return makeVoiceCaptureFailure(known.data);
  }
  return makeVoiceCaptureFailure(legacyReasonCodes[storedReason] ?? "transcription_failed");
}
