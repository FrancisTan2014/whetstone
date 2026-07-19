import type {
  CaptureLanguage,
  VoiceCaptureAcceptedDto,
  VoiceCaptureStatus,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { diaryEntries, entries, personalEntries } from "../../db/schema.js";
import { resolveVoiceCaptureFailure } from "./voiceCaptureFailure.js";

// Real infrastructure boundaries (db, id generation, the durable audio store) are injected so the voice
// capture commands stay deterministic and testable; `now` is passed in for the same reason.
export type VoiceCaptureDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  // Remove a saved raw-audio file by the path `saveAudio` returned, when a failed capture is discarded so
  // its clip does not linger on disk. Best-effort at the caller: a missing file is not an error.
  deleteAudio: (path: string) => Promise<void>;
  // Persist the raw audio bytes under a server-owned path and return that path. Durable (survives a
  // restart) so a queued capture is never lost before the worker transcribes it.
  saveAudio: (audio: Buffer) => Promise<string>;
}>;

export type GetVoiceCaptureStatusResult =
  | Readonly<{ status: "found"; capture: VoiceCaptureStatusDto }>
  | Readonly<{ status: "not_found" }>;

export type RetryVoiceCaptureResult =
  | Readonly<{ status: "retried"; capture: VoiceCaptureStatusDto }>
  | Readonly<{ status: "not_failed" }>
  | Readonly<{ status: "not_found" }>;

export type RemoveVoiceCaptureResult =
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "not_failed" }>
  | Readonly<{ status: "not_found" }>;

// The persisted async-voice-capture row, narrowed to what the status DTO needs. `processingStatus` is
// non-null here because every read scopes to `IS NOT NULL` (the queued voice path); a synchronous typed
// capture (status null) is not an async voice capture and is never addressed here. Chronology comes from
// the shared `personal_entries` facet.
type VoiceCaptureRow = Readonly<{
  bodyText: string;
  entryId: string;
  failureReason: string | null;
  language: string | null;
  occurredAt: Date;
  processingStatus: VoiceCaptureStatus;
}>;

const statusColumns = {
  bodyText: diaryEntries.bodyText,
  entryId: diaryEntries.entryId,
  failureReason: diaryEntries.failureReason,
  language: diaryEntries.language,
  occurredAt: personalEntries.occurredAt,
  processingStatus: diaryEntries.processingStatus
} as const;

// Project a persisted capture into its pollable status. `text` is the ready entry's plaintext body only
// once `ready`; while pending or on failure it is null — never a fake placeholder that looks ready (#565).
// `failure` is the stable, safe category (with its retry affordance) resolved from the persisted reason,
// never the raw stored/adapter text (#675).
function toVoiceCaptureStatusDto(row: VoiceCaptureRow): VoiceCaptureStatusDto {
  return {
    failure: resolveVoiceCaptureFailure(row.failureReason),
    id: row.entryId,
    language: row.language as CaptureLanguage | null,
    occurredAt: row.occurredAt.toISOString(),
    status: row.processingStatus,
    text: row.processingStatus === "ready" ? row.bodyText : null
  };
}

// Submit a Tap-and-Talk clip, save-first (#571): store the raw audio under a server-owned path and create
// a pending diary Entry immediately (`processing_status = "queued"`) with an empty placeholder body and
// `language = null`, BEFORE any transcription — then return promptly with the capture id + status so the
// user can record again without waiting for STT. No capture language is chosen: the worker fills the
// detected language when transcription runs (#647). Three rows are written in one transaction (owning
// Entry + the shared `personal_entries` chronology facet + the `diary_entries` facet) so a capture never
// exists without its identity; the server owns the id and the timestamps so the client cannot forge or
// backdate a capture.
export async function submitVoiceCapture(
  dependencies: VoiceCaptureDependencies,
  audio: Buffer,
  userId: string,
  now: Date
): Promise<VoiceCaptureAcceptedDto> {
  const rawAudioPath = await dependencies.saveAudio(audio);
  const entryId = dependencies.createId();
  const bodyDoc = createTextDocument("");

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: entryId, type: "diary_entry" });
    await tx
      .insert(personalEntries)
      .values({ createdAt: now, entryId, occurredAt: now, updatedAt: now, userId });
    await tx.insert(diaryEntries).values({
      bodyDoc,
      bodyText: "",
      entryId,
      failureReason: null,
      inputMode: "voice",
      language: null,
      processingStatus: "queued",
      rawAudioPath,
      rawTranscript: null,
      tidiedText: null
    });
  });

  return { id: entryId, status: "queued" };
}

// List the user's active voice captures for the frontend to rebuild its pending UI on load/refresh
// (#566): every capture still in flight (`queued`/`transcribing`/`tidying`) or `failed`. Ready captures
// are excluded — they already appear in the Timeline as ordinary diary entries, so returning them here
// would double them. Scoped to the owner AND to async voice captures (a status is set), ordered by
// capture time (oldest first) so pending rows render in the user's capture order.
export async function listActiveVoiceCaptures(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<VoiceCaptureStatusDto>> {
  const rows = await db
    .select(statusColumns)
    .from(diaryEntries)
    .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        isNotNull(diaryEntries.processingStatus),
        ne(diaryEntries.processingStatus, "ready")
      )
    )
    .orderBy(asc(personalEntries.createdAt), asc(diaryEntries.entryId));
  return (rows as ReadonlyArray<VoiceCaptureRow>).map(toVoiceCaptureStatusDto);
}

async function loadVoiceCaptureRow(
  db: DbClient,
  id: string,
  userId: string
): Promise<VoiceCaptureRow | undefined> {
  const [row] = await db
    .select(statusColumns)
    .from(diaryEntries)
    .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
    .where(
      and(
        eq(diaryEntries.entryId, id),
        eq(personalEntries.userId, userId),
        isNotNull(diaryEntries.processingStatus)
      )
    )
    .limit(1);
  return row as VoiceCaptureRow | undefined;
}

// Poll one voice capture's status. Scoped to the owner AND to async voice captures (a status is set), so
// a forged id, another user's capture, or a synchronous typed entry returns not_found (404).
export async function getVoiceCaptureStatus(
  db: DbClient,
  id: string,
  userId: string
): Promise<GetVoiceCaptureStatusResult> {
  const row = await loadVoiceCaptureRow(db, id, userId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  return { capture: toVoiceCaptureStatusDto(row), status: "found" };
}

// Retry a failed voice capture: reset it to `queued` (clearing the failure reason) so the worker picks it
// up again. The raw audio was never lost, so this re-transcribes from the same clip. Only a `failed`
// capture is retryable — a still-running or already-`ready` one returns `not_failed` (409) rather than
// re-queueing and risking a duplicate. Scoped to the owner; an unknown id returns not_found (404).
export async function retryVoiceCapture(
  db: DbClient,
  id: string,
  userId: string
): Promise<RetryVoiceCaptureResult> {
  const existing = await loadVoiceCaptureRow(db, id, userId);
  if (existing === undefined) {
    return { status: "not_found" };
  }
  if (existing.processingStatus !== "failed") {
    return { status: "not_failed" };
  }

  await db
    .update(diaryEntries)
    .set({ failureReason: null, processingStatus: "queued" })
    .where(eq(diaryEntries.entryId, id));

  return {
    capture: {
      ...toVoiceCaptureStatusDto(existing),
      failure: null,
      status: "queued",
      text: null
    },
    status: "retried"
  };
}

// Remove a failed voice capture and its saved recording: delete the diary facet, the shared
// personal-entry facet, and the owning Entry in one transaction, then best-effort delete the raw audio
// file so a discarded clip does not linger on disk. This is the terminal action for a failure the learner
// cannot recover (no speech, a missing recording) and the alternative to retry for one they could — so
// both retryable and non-retryable failed captures may be removed. Only a `failed` capture is removable
// (a still-running or `ready` one returns `not_failed`, 409); scoped to the owner (an unknown or another
// user's id returns not_found, 404), so removal can never touch an unowned or in-flight row.
export async function removeFailedVoiceCapture(
  dependencies: VoiceCaptureDependencies,
  id: string,
  userId: string
): Promise<RemoveVoiceCaptureResult> {
  const removed = await dependencies.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({
        processingStatus: diaryEntries.processingStatus,
        rawAudioPath: diaryEntries.rawAudioPath
      })
      .from(diaryEntries)
      .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
      .where(
        and(
          eq(diaryEntries.entryId, id),
          eq(personalEntries.userId, userId),
          isNotNull(diaryEntries.processingStatus)
        )
      )
      .limit(1);

    if (owned === undefined) {
      return { status: "not_found" } as const;
    }
    if (owned.processingStatus !== "failed") {
      return { status: "not_failed" } as const;
    }

    await tx.delete(diaryEntries).where(eq(diaryEntries.entryId, id));
    await tx.delete(personalEntries).where(eq(personalEntries.entryId, id));
    await tx.delete(entries).where(eq(entries.id, id));

    return { rawAudioPath: owned.rawAudioPath, status: "removed" } as const;
  });

  if (removed.status === "removed" && removed.rawAudioPath !== null) {
    await dependencies.deleteAudio(removed.rawAudioPath);
  }
  return removed.status === "removed" ? { status: "removed" } : removed;
}
