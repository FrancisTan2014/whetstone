import { asc, eq, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { proposalCandidates, timelineEntries } from "../../db/schema.js";
import type { SpeechInput } from "../../speech/speechInput.js";
import {
  proposeForCapture,
  type CaptureProposalDependencies
} from "../makeDurable/captureCommands.js";
import type { DiaryTidy } from "./diaryTidy.js";

// Everything the background voice-capture worker needs: the proposal seam it shares with typed capture
// (`CaptureProposalDependencies` — db, id, the Make Durable proposal provider) plus the STT seam and the
// diary tidy pass. One worker, one capture at a time (#565): no concurrency in v0 keeps ordering, model
// load, and failure recovery simple.
export type VoiceCaptureWorkerDependencies = CaptureProposalDependencies &
  Readonly<{
    speech: SpeechInput;
    tidy: DiaryTidy;
  }>;

// The outcome of one worker tick. `idle` = nothing was queued. `processed` = a capture reached `ready`
// (its Timeline text is filled and the Make Durable gate ran; `cardCreated` says whether a review card
// surfaced). `failed` = the worker gave up on the claimed capture (its raw audio is kept for retry).
export type VoiceCaptureProcessResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "processed"; id: string; cardCreated: boolean }>
  | Readonly<{ status: "failed"; id: string; reason: string }>;

// The in-progress states a worker leaves behind when its process dies mid-tick. On restart they are
// requeued so no capture is stranded (`requeueStalledVoiceCaptures`). `ready`/`failed` are terminal and
// never requeued, so a completed proposal never re-runs.
const STALLED_STATES = ["transcribing", "tidying"] as const;

type ClaimedCapture = Readonly<{
  entryId: string;
  language: string | null;
  rawAudioPath: string | null;
  userId: string;
}>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Claim the oldest queued voice capture and move it to `transcribing` in one transaction, so a second
// tick (or a re-entrant runner) never picks the same row. Oldest-first by capture instant, with the id
// as a stable tiebreak for captures sharing an instant. Returns undefined when the queue is empty.
async function claimOldestQueued(db: DbClient): Promise<ClaimedCapture | undefined> {
  return db.transaction(async (tx) => {
    const [oldest] = await tx
      .select({
        entryId: timelineEntries.entryId,
        language: timelineEntries.language,
        rawAudioPath: timelineEntries.rawAudioPath,
        userId: timelineEntries.userId
      })
      .from(timelineEntries)
      .where(eq(timelineEntries.processingStatus, "queued"))
      .orderBy(asc(timelineEntries.createdAt), asc(timelineEntries.entryId))
      .limit(1);

    if (oldest === undefined) {
      return undefined;
    }

    await tx
      .update(timelineEntries)
      .set({ processingStatus: "transcribing", failureReason: null })
      .where(eq(timelineEntries.entryId, oldest.entryId));

    return oldest;
  });
}

async function failCapture(db: DbClient, entryId: string, reason: string): Promise<void> {
  await db
    .update(timelineEntries)
    .set({ processingStatus: "failed", failureReason: reason })
    .where(eq(timelineEntries.entryId, entryId));
}

// Has this capture already produced a Make Durable candidate? The worker guards on this so reprocessing
// a requeued capture (restart recovery / retry) never creates a duplicate proposal candidate (#565).
async function hasProposalForEntry(db: DbClient, timelineEntryId: string): Promise<boolean> {
  const rows = await db
    .select({ id: proposalCandidates.id })
    .from(proposalCandidates)
    .where(eq(proposalCandidates.timelineEntryId, timelineEntryId))
    .limit(1);
  return rows.length > 0;
}

// Requeue captures a dead worker left mid-flight (`transcribing`/`tidying`) so a restart resumes them
// instead of stranding the raw audio. Called once at worker startup. Terminal `ready`/`failed` rows are
// untouched, so a finished proposal never re-runs. Returns how many rows were requeued.
export async function requeueStalledVoiceCaptures(db: DbClient): Promise<number> {
  const requeued = await db
    .update(timelineEntries)
    .set({ processingStatus: "queued", failureReason: null })
    .where(inArray(timelineEntries.processingStatus, [...STALLED_STATES]))
    .returning({ entryId: timelineEntries.entryId });
  return requeued.length;
}

// Process the next queued voice capture, oldest first: transcribe → tidy → mark ready → run the shared
// Make Durable proposal gate. The durable `ready` transition (raw transcript + tidied text) is committed
// BEFORE the opportunistic proposal, so a crash or model failure during the proposal cannot revert the
// capture or re-run it (a `ready` row is never re-claimed). Any STT failure — including an empty
// transcript or missing audio — marks the capture `failed` with a reason and keeps the raw audio, rather
// than fabricating a ready entry. Returns `idle` when the queue is empty.
export async function processNextVoiceCapture(
  dependencies: VoiceCaptureWorkerDependencies,
  now: Date
): Promise<VoiceCaptureProcessResult> {
  const claimed = await claimOldestQueued(dependencies.db);
  if (claimed === undefined) {
    return { status: "idle" };
  }

  if (claimed.rawAudioPath === null) {
    const reason = "missing_audio";
    await failCapture(dependencies.db, claimed.entryId, reason);
    return { status: "failed", id: claimed.entryId, reason };
  }

  let transcript: string;
  try {
    const audio =
      claimed.language === null
        ? { path: claimed.rawAudioPath }
        : { language: claimed.language, path: claimed.rawAudioPath };
    transcript = (await dependencies.speech.transcribe(audio)).transcript.trim();
  } catch (error) {
    const reason = describeError(error);
    await failCapture(dependencies.db, claimed.entryId, reason);
    return { status: "failed", id: claimed.entryId, reason };
  }

  // An empty transcript (silence, or an unconfigured/failed STT that yields no text) is a failure, not a
  // ready — an empty diary entry is not a real capture, and marking it failed keeps the audio retryable
  // once STT is configured, rather than persisting a hollow "ready" row.
  if (transcript.length === 0) {
    const reason = "empty_transcript";
    await failCapture(dependencies.db, claimed.entryId, reason);
    return { status: "failed", id: claimed.entryId, reason };
  }

  await dependencies.db
    .update(timelineEntries)
    .set({ rawInputText: transcript, processingStatus: "tidying" })
    .where(eq(timelineEntries.entryId, claimed.entryId));

  // Tidy never throws and never fails capture: it falls back to the raw transcript when the model is
  // unavailable or its reply is not a faithful tidy (see `createDiaryTidy`).
  const tidied = await dependencies.tidy(transcript);

  await dependencies.db
    .update(timelineEntries)
    .set({ tidiedText: tidied, processingStatus: "ready" })
    .where(eq(timelineEntries.entryId, claimed.entryId));

  // Best-effort Make Durable proposal on the now-ready capture, guarded so a reprocessed capture never
  // creates a duplicate candidate. The entry is already durable and ready; a proposal that yields nothing
  // simply leaves no card.
  let cardCreated = false;
  if (!(await hasProposalForEntry(dependencies.db, claimed.entryId))) {
    const card = await proposeForCapture(
      dependencies,
      transcript,
      claimed.userId,
      claimed.entryId,
      now
    );
    cardCreated = card !== null;
  }

  return { status: "processed", id: claimed.entryId, cardCreated };
}
