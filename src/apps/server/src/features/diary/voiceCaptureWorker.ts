import { captureLanguageSchema, type VoiceCaptureFailureCode } from "@whetstone/contracts";
import { createTextDocument, documentReadableText } from "@whetstone/document";
import { asc, eq, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { diaryEntries, personalEntries } from "../../db/schema.js";
import { classifyEmptyTranscript } from "../../speech/speechFailure.js";
import type { SpeechInput } from "../../speech/speechInput.js";
import type { DiaryTidy } from "./diaryTidy.js";

// The safe server log of a raw transcription failure: the untyped adapter/process message is recorded
// here, with the capture id and the category it was classified as, so operational detail stays in server
// logs and never crosses the status/list API into the browser (#675).
export type VoiceCaptureFailureLogger = (
  event: Readonly<{ captureId: string; category: VoiceCaptureFailureCode; rawMessage: string }>
) => void;

// Everything the background voice-capture worker needs: the STT seam and the diary tidy pass. A diary
// capture journals only (#571) — there is no Make Durable proposal step — so the worker just fills the
// durable body. One worker, one capture at a time (#565): no concurrency in v0 keeps ordering, model
// load, and failure recovery simple. `speechConfigured` is the speech boundary's report of whether local
// STT is set up on this machine, so an empty transcript is classified as genuine silence vs. missing
// voice setup (#675). `logFailure` keeps raw adapter/process text in safe server logs only.
export type VoiceCaptureWorkerDependencies = Readonly<{
  db: DbClient;
  logFailure: VoiceCaptureFailureLogger;
  speech: SpeechInput;
  speechConfigured: boolean;
  tidy: DiaryTidy;
}>;

// The outcome of one worker tick. `idle` = nothing was queued. `processed` = a capture reached `ready`
// (its durable body is filled from the tidied transcript). `failed` = the worker gave up on the claimed
// capture (its raw audio is kept for retry), carrying the stable failure category — never a raw message.
export type VoiceCaptureProcessResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{ id: string; status: "processed" }>
  | Readonly<{ code: VoiceCaptureFailureCode; id: string; status: "failed" }>;

// The in-progress states a worker leaves behind when its process dies mid-tick. On restart they are
// requeued so no capture is stranded (`requeueStalledVoiceCaptures`). `ready`/`failed` are terminal and
// never requeued, so a completed capture never re-runs.
const STALLED_STATES = ["transcribing", "tidying"] as const;

type ClaimedCapture = Readonly<{
  entryId: string;
  rawAudioPath: string | null;
}>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Narrow Whisper's auto-detected language to a supported capture language (`zh`/`en`), or null when the
// model reported none or an unsupported one (#647). A missing/unsupported detection is not a failure —
// the stored language simply stays null.
function toSupportedLanguage(detected: string | null): string | null {
  const parsed = captureLanguageSchema.safeParse(detected);
  return parsed.success ? parsed.data : null;
}

// Claim the oldest queued voice capture and move it to `transcribing` in one transaction, so a second
// tick (or a re-entrant runner) never picks the same row. Oldest-first by capture instant (from the
// shared chronology facet), with the id as a stable tiebreak for captures sharing an instant. Returns
// undefined when the queue is empty.
async function claimOldestQueued(db: DbClient): Promise<ClaimedCapture | undefined> {
  return db.transaction(async (tx) => {
    const [oldest] = await tx
      .select({
        entryId: diaryEntries.entryId,
        rawAudioPath: diaryEntries.rawAudioPath
      })
      .from(diaryEntries)
      .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
      .where(eq(diaryEntries.processingStatus, "queued"))
      .orderBy(asc(personalEntries.createdAt), asc(diaryEntries.entryId))
      .limit(1);

    if (oldest === undefined) {
      return undefined;
    }

    await tx
      .update(diaryEntries)
      .set({ failureReason: null, processingStatus: "transcribing" })
      .where(eq(diaryEntries.entryId, oldest.entryId));

    return oldest;
  });
}

async function failCapture(
  db: DbClient,
  entryId: string,
  code: VoiceCaptureFailureCode
): Promise<void> {
  await db
    .update(diaryEntries)
    .set({ failureReason: code, processingStatus: "failed" })
    .where(eq(diaryEntries.entryId, entryId));
}

// Requeue captures a dead worker left mid-flight (`transcribing`/`tidying`) so a restart resumes them
// instead of stranding the raw audio. Called once at worker startup. Terminal `ready`/`failed` rows are
// untouched, so a finished capture never re-runs. Returns how many rows were requeued.
export async function requeueStalledVoiceCaptures(db: DbClient): Promise<number> {
  const requeued = await db
    .update(diaryEntries)
    .set({ failureReason: null, processingStatus: "queued" })
    .where(inArray(diaryEntries.processingStatus, [...STALLED_STATES]))
    .returning({ entryId: diaryEntries.entryId });
  return requeued.length;
}

// Process the next queued voice capture, oldest first: transcribe → tidy → build the durable body → mark
// ready. The `ready` transition writes the ProseMirror/Tiptap body (from the tidied transcript) plus its
// plaintext projection, so the diary Entry's durable body is the same rich document a typed capture
// stores. Any STT failure — including an empty transcript or missing audio — marks the capture `failed`
// with a reason and keeps the raw audio, rather than fabricating a ready entry. Returns `idle` when the
// queue is empty.
export async function processNextVoiceCapture(
  dependencies: VoiceCaptureWorkerDependencies
): Promise<VoiceCaptureProcessResult> {
  const claimed = await claimOldestQueued(dependencies.db);
  if (claimed === undefined) {
    return { status: "idle" };
  }

  if (claimed.rawAudioPath === null) {
    await failCapture(dependencies.db, claimed.entryId, "recording_missing");
    return { code: "recording_missing", id: claimed.entryId, status: "failed" };
  }

  let transcript: string;
  let detectedLanguage: string | null;
  try {
    const transcription = await dependencies.speech.transcribe({ path: claimed.rawAudioPath });
    transcript = transcription.transcript.trim();
    detectedLanguage = toSupportedLanguage(transcription.language);
  } catch (error) {
    // A transient transcription fault (a crashed/failing local adapter or process). The raw message is
    // kept in safe server logs with the capture id; only the stable `transcription_failed` category is
    // persisted and returned, so no stderr/path can leak to the browser (#675).
    dependencies.logFailure({
      captureId: claimed.entryId,
      category: "transcription_failed",
      rawMessage: describeError(error)
    });
    await failCapture(dependencies.db, claimed.entryId, "transcription_failed");
    return { code: "transcription_failed", id: claimed.entryId, status: "failed" };
  }

  // An empty transcript is a failure, not a ready — an empty diary entry is not a real capture, and
  // marking it failed keeps the audio retryable. The speech boundary classifies whether this is genuine
  // silence (`no_speech`) or missing local voice setup (`voice_setup_required`), which `pnpm setup:voice`
  // fixes; either way the raw audio is kept rather than persisting a hollow "ready" row.
  if (transcript.length === 0) {
    const code = classifyEmptyTranscript(dependencies.speechConfigured);
    await failCapture(dependencies.db, claimed.entryId, code);
    return { code, id: claimed.entryId, status: "failed" };
  }

  await dependencies.db
    .update(diaryEntries)
    .set({ processingStatus: "tidying", rawTranscript: transcript })
    .where(eq(diaryEntries.entryId, claimed.entryId));

  // Tidy never throws and never fails capture: it falls back to the raw transcript when the model is
  // unavailable or its reply is not a faithful tidy (see `createDiaryTidy`).
  const tidied = await dependencies.tidy(transcript);
  const bodyDoc = createTextDocument(tidied);
  const bodyText = documentReadableText(bodyDoc);

  await dependencies.db
    .update(diaryEntries)
    .set({
      bodyDoc,
      bodyText,
      language: detectedLanguage,
      processingStatus: "ready",
      tidiedText: tidied
    })
    .where(eq(diaryEntries.entryId, claimed.entryId));

  return { id: claimed.entryId, status: "processed" };
}
