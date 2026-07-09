import { isDayKey } from "@whetstone/domain";
import { z } from "zod";

import { captureLanguageSchema } from "./captureContracts.js";

// Shared, Zod-validated shapes for the asynchronous Tap-and-Talk voice capture (#565). A voice clip is
// saved and durable BEFORE speech-to-text runs: submitting returns a pending capture id + status
// immediately, and a background worker later transcribes → tidies → makes it ready. The frontend polls
// the status endpoint to learn when the entry is ready (or why it failed). Every value crossing the
// voice-capture API is described here; the server validates once at the boundary.

// The lifecycle a queued voice capture walks: created `queued`, claimed by the worker as `transcribing`,
// then `tidying`, then `ready` (its Timeline text is filled and the Make Durable gate has run) — or
// `failed` when the worker gave up (the raw audio is kept so it can be retried). Ordered from first to
// terminal so the frontend can render progress.
export const voiceCaptureStatuses = [
  "queued",
  "transcribing",
  "tidying",
  "ready",
  "failed"
] as const;

export const voiceCaptureStatusSchema = z.enum(voiceCaptureStatuses);

export type VoiceCaptureStatus = z.infer<typeof voiceCaptureStatusSchema>;

// Submit query: the manual capture language (#561) — no auto-detection in v0. The audio bytes travel as
// the request body (an octet-stream), not in this query.
export const submitVoiceCaptureQuerySchema = z.object({ language: captureLanguageSchema }).strict();

export type SubmitVoiceCaptureQuery = z.infer<typeof submitVoiceCaptureQuerySchema>;

// The prompt acceptance response: the pending capture's id and status (always `queued` on submit), so
// the client can start polling immediately without waiting for STT.
export const voiceCaptureAcceptedDtoSchema = z
  .object({
    id: z.string(),
    status: voiceCaptureStatusSchema
  })
  .strict();

export type VoiceCaptureAcceptedDto = z.infer<typeof voiceCaptureAcceptedDtoSchema>;

const dayKeySchema = z.string().refine(isDayKey, { message: "must be a YYYY-MM-DD date." });

// The pollable status of one voice capture. `text` is the tidied entry once ready (null while pending or
// on failure — never a fake placeholder). `failureReason` is set only for `failed`. `language`/`entryDate`
// /`createdAt` mirror the persisted capture so the client can render the pending row in place.
export const voiceCaptureStatusDtoSchema = z
  .object({
    createdAt: z.string(),
    entryDate: dayKeySchema,
    failureReason: z.string().nullable(),
    id: z.string(),
    language: captureLanguageSchema.nullable(),
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
