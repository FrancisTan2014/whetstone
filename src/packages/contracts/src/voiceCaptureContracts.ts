import { z } from "zod";

import { captureLanguageSchema } from "./captureContracts.js";

// (No submit query schema: a voice capture no longer carries a manual capture language — Whisper
// auto-detects the language during transcription, #647.)

// The content type for raw recorded-audio uploads: a voice clip's bytes travel as an octet-stream
// request body (not multipart), so the server registers a matching body parser once and the client
// sets this as the upload's `content-type`.
export const audioContentType = "application/octet-stream";

// Shared, Zod-validated shapes for the asynchronous Tap-and-Talk voice capture (#565). A voice clip is
// saved and durable BEFORE speech-to-text runs: submitting returns a pending capture id + status
// immediately, and a background worker later transcribes → tidies → makes it ready. The frontend polls
// the status endpoint to learn when the entry is ready (or why it failed). Every value crossing the
// voice-capture API is described here; the server validates once at the boundary.

// The lifecycle a queued voice capture walks: created `queued`, claimed by the worker as `transcribing`,
// then `tidying`, then `ready` (its durable diary body is built from the tidied text) — or `failed` when
// the worker gave up (the raw audio is kept so it can be retried). Ordered from first to terminal so the
// frontend can render progress.
export const voiceCaptureStatuses = [
  "queued",
  "transcribing",
  "tidying",
  "ready",
  "failed"
] as const;

export const voiceCaptureStatusSchema = z.enum(voiceCaptureStatuses);

export type VoiceCaptureStatus = z.infer<typeof voiceCaptureStatusSchema>;

// The stable, safe failure categories a `failed` capture exposes to the client. Operational detail
// (raw adapter/process output) never crosses this boundary — only which category of thing went wrong,
// so UI copy stays actionable and no stderr or path can leak into the browser:
//   - `no_speech`             — transcription produced no text (silence / no utterance);
//   - `voice_setup_required`  — local speech-to-text is not configured on this machine;
//   - `transcription_failed`  — a transient failure while transcribing (the recording is intact);
//   - `recording_missing`     — the saved recording could not be found.
export const voiceCaptureFailureCodes = [
  "no_speech",
  "voice_setup_required",
  "transcription_failed",
  "recording_missing"
] as const;

export const voiceCaptureFailureCodeSchema = z.enum(voiceCaptureFailureCodes);

export type VoiceCaptureFailureCode = z.infer<typeof voiceCaptureFailureCodeSchema>;

// Which categories can be retried from the same saved recording. `voice_setup_required` and
// `transcription_failed` leave the audio intact, so re-queuing it once STT is set up or a transient
// fault clears can succeed. `no_speech` (nothing was said) and `recording_missing` (the audio is gone)
// cannot be fixed by re-transcribing the same clip, so they are not retryable — the client offers
// removal instead of a retry loop that cannot win.
const retryableFailureCodes: ReadonlySet<VoiceCaptureFailureCode> = new Set([
  "voice_setup_required",
  "transcription_failed"
]);

export function isRetryableVoiceCaptureFailure(code: VoiceCaptureFailureCode): boolean {
  return retryableFailureCodes.has(code);
}

// A `failed` capture's client-facing failure: the safe category plus whether the saved recording can be
// retried. Kept as a discriminated value (not a free-form string) so the UI renders category-specific,
// actionable copy and can never surface raw adapter text.
export const voiceCaptureFailureSchema = z
  .object({
    code: voiceCaptureFailureCodeSchema,
    retryable: z.boolean()
  })
  .strict();

export type VoiceCaptureFailure = z.infer<typeof voiceCaptureFailureSchema>;

// Build the client-facing failure from a category, deriving `retryable` from the code so the two can
// never drift apart.
export function makeVoiceCaptureFailure(code: VoiceCaptureFailureCode): VoiceCaptureFailure {
  return { code, retryable: isRetryableVoiceCaptureFailure(code) };
}

// The prompt acceptance response: the pending capture's id and status (always `queued` on submit), so
// the client can start polling immediately without waiting for STT.
export const voiceCaptureAcceptedDtoSchema = z
  .object({
    id: z.string(),
    status: voiceCaptureStatusSchema
  })
  .strict();

export type VoiceCaptureAcceptedDto = z.infer<typeof voiceCaptureAcceptedDtoSchema>;

// The pollable status of one voice capture. `text` is the tidied entry once ready (null while pending or
// on failure — never a fake placeholder). `failure` is set only for `failed` (null otherwise): a stable,
// safe category plus whether the saved recording can be retried — never raw adapter/process text.
// `language` is the language Whisper auto-detected once transcription runs (null while queued, or when
// detection produced no supported value, #647); `occurredAt` mirrors the persisted capture so the client
// can render the pending row in place and, once ready, build the Timeline entry from it (its day is
// derived from `occurredAt`).
export const voiceCaptureStatusDtoSchema = z
  .object({
    failure: voiceCaptureFailureSchema.nullable(),
    id: z.string(),
    language: captureLanguageSchema.nullable(),
    occurredAt: z.string(),
    status: voiceCaptureStatusSchema,
    text: z.string().nullable()
  })
  .strict();

export type VoiceCaptureStatusDto = z.infer<typeof voiceCaptureStatusDtoSchema>;

// The active voice captures the client rebuilds its pending UI from on load/refresh (#566): every capture
// still in flight (`queued`/`transcribing`/`tidying`) or `failed`. Ready captures are omitted — they are
// already in the Timeline as ordinary entries, so listing them here would duplicate them. Ordered by
// capture time (oldest first) so the client renders pending rows in the user's capture order.
export const voiceCaptureListDtoSchema = z
  .object({ captures: z.array(voiceCaptureStatusDtoSchema) })
  .strict();

export type VoiceCaptureListDto = z.infer<typeof voiceCaptureListDtoSchema>;

export function parseVoiceCaptureAcceptedDto(value: unknown): VoiceCaptureAcceptedDto {
  return voiceCaptureAcceptedDtoSchema.parse(value);
}

export function parseVoiceCaptureStatusDto(value: unknown): VoiceCaptureStatusDto {
  return voiceCaptureStatusDtoSchema.parse(value);
}

export function parseVoiceCaptureListDto(value: unknown): VoiceCaptureListDto {
  return voiceCaptureListDtoSchema.parse(value);
}
