import type {
  CaptureLanguage,
  VoiceCaptureAcceptedDto,
  VoiceCaptureStatus,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";
import { toDayKey } from "@whetstone/domain";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, timelineEntries } from "../../db/schema.js";

// Real infrastructure boundaries (db, id generation, the durable audio store) are injected so the voice
// capture commands stay deterministic and testable; `now` is passed in for the same reason.
export type VoiceCaptureDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
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

// The persisted async-voice-capture row, narrowed to what the status DTO needs. `processingStatus` is
// non-null here because every read scopes to `IS NOT NULL` (the queued voice path); a synchronous
// capture (typed / legacy, status null) is not an async voice capture and is never addressed here.
type VoiceCaptureRow = Readonly<{
  createdAt: Date;
  entryDate: string;
  failureReason: string | null;
  entryId: string;
  language: string | null;
  processingStatus: VoiceCaptureStatus;
  rawInputText: string;
  tidiedText: string | null;
}>;

const statusColumns = {
  createdAt: timelineEntries.createdAt,
  entryDate: timelineEntries.entryDate,
  failureReason: timelineEntries.failureReason,
  entryId: timelineEntries.entryId,
  language: timelineEntries.language,
  processingStatus: timelineEntries.processingStatus,
  rawInputText: timelineEntries.rawInputText,
  tidiedText: timelineEntries.tidiedText
} as const;

// Project a persisted capture into its pollable status. `text` is the tidied entry only once `ready`;
// while pending or on failure it is null — never a fake placeholder that looks ready (#565).
function toVoiceCaptureStatusDto(row: VoiceCaptureRow): VoiceCaptureStatusDto {
  return {
    createdAt: row.createdAt.toISOString(),
    entryDate: row.entryDate,
    failureReason: row.failureReason,
    id: row.entryId,
    language: row.language as CaptureLanguage | null,
    status: row.processingStatus,
    text: row.processingStatus === "ready" ? (row.tidiedText ?? row.rawInputText) : null
  };
}

// Submit a Tap-and-Talk clip: save the raw audio under a server-owned path and create a pending,
// diary-sourced Timeline capture immediately (`processing_status = "queued"`), then return promptly with
// the capture id + status so the user can record again without waiting for STT. The transcript is empty
// until the background worker transcribes it — an honest pending row, not a fabricated transcript. The
// server owns the id, `created_at`, and `entry_date` so the client cannot forge or backdate a capture.
// Registering the owning Entry and the capture row in one transaction keeps a capture from ever existing
// without its Entry.
export async function submitVoiceCapture(
  dependencies: VoiceCaptureDependencies,
  audio: Buffer,
  language: CaptureLanguage,
  userId: string,
  now: Date
): Promise<VoiceCaptureAcceptedDto> {
  const rawAudioPath = await dependencies.saveAudio(audio);
  const entryId = dependencies.createId();

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: entryId, type: "timeline_entry" });
    await tx.insert(timelineEntries).values({
      entryId,
      userId,
      createdAt: now,
      entryDate: toDayKey(now),
      inputMode: "voice",
      captureSource: "diary",
      rawInputText: "",
      tidiedText: null,
      language,
      rawAudioPath,
      processingStatus: "queued",
      failureReason: null
    });
  });

  return { id: entryId, status: "queued" };
}

// List the user's active voice captures for the frontend to rebuild its pending UI on load/refresh
// (#566): every capture still in flight (`queued`/`transcribing`/`tidying`) or `failed`. Ready captures
// are excluded — they already appear in the Timeline as ordinary entries, so returning them here would
// double them. Scoped to the current user AND diary-sourced voice captures (a status is set), ordered by
// capture time (oldest first) so pending rows render in the user's capture order.
export async function listActiveVoiceCaptures(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<VoiceCaptureStatusDto>> {
  const rows = await db
    .select(statusColumns)
    .from(timelineEntries)
    .where(
      and(
        eq(timelineEntries.userId, userId),
        eq(timelineEntries.captureSource, "diary"),
        isNotNull(timelineEntries.processingStatus),
        ne(timelineEntries.processingStatus, "ready")
      )
    )
    .orderBy(asc(timelineEntries.createdAt));
  return (rows as ReadonlyArray<VoiceCaptureRow>).map(toVoiceCaptureStatusDto);
}

async function loadVoiceCaptureRow(
  db: DbClient,
  id: string,
  userId: string
): Promise<VoiceCaptureRow | undefined> {
  const [row] = await db
    .select(statusColumns)
    .from(timelineEntries)
    .where(
      and(
        eq(timelineEntries.entryId, id),
        eq(timelineEntries.userId, userId),
        isNotNull(timelineEntries.processingStatus)
      )
    )
    .limit(1);
  return row as VoiceCaptureRow | undefined;
}

// Poll one voice capture's status. Scoped to the current user AND to async voice captures (a status is
// set), so a forged id, another user's capture, or a synchronous Timeline entry returns not_found (404).
export async function getVoiceCaptureStatus(
  db: DbClient,
  id: string,
  userId: string
): Promise<GetVoiceCaptureStatusResult> {
  const row = await loadVoiceCaptureRow(db, id, userId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  return { status: "found", capture: toVoiceCaptureStatusDto(row) };
}

// Retry a failed voice capture: reset it to `queued` (clearing the failure reason) so the worker picks
// it up again. The raw audio was never lost, so this re-transcribes from the same clip. Only a `failed`
// capture is retryable — a still-running or already-`ready` one returns `not_failed` (409) rather than
// re-queueing and risking a duplicate. Scoped to the current user; an unknown id returns not_found (404).
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

  const [row] = await db
    .update(timelineEntries)
    .set({ processingStatus: "queued", failureReason: null })
    .where(and(eq(timelineEntries.entryId, id), eq(timelineEntries.userId, userId)))
    .returning(statusColumns);

  return { status: "retried", capture: toVoiceCaptureStatusDto(row as VoiceCaptureRow) };
}
