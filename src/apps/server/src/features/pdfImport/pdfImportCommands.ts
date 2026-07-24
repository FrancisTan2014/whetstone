import type { PdfImportStartedDto, PdfImportStatusDto } from "@whetstone/contracts";
import { isTerminalAttemptState, type WorkLanguage } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import type { PdfImportCleanupLogger, PdfImportActiveRuns } from "./pdfImportRunner.js";
import { buildPdfImportStatus } from "./pdfImportQueries.js";
import type { PdfImportStageStore } from "./pdfImportStage.js";
import {
  getAttempt,
  clearStagePath,
  insertQueuedAttempt,
  markCancelled,
  retryInterrupted,
  type Executor,
  type PdfImportAttemptRecord
} from "./pdfImportStore.js";

// The owner-scoped start / cancel / retry / cleanup-retry commands for a recoverable staged PDF import
// (#721). These own the stage lifecycle boundary: an upload is STREAMED into a fresh stage
// (`stagePdfUpload`, hashing as it arrives — never buffering the whole file), then bound to a queued
// attempt (`bindStagedPdfAttempt`) or discarded (`discardStagedPdfUpload`) after the dedup check; cancel
// terminates the owned child, fences late output (via the store), and removes the stage; retry re-queues
// an interrupted attempt to resume; cleanup-retry re-removes a terminal attempt's leftover stage when an
// earlier removal failed. None of them create a Work, ReadingUnit, or Block — publication is #702.

export type PdfImportCommandDependencies = Readonly<{
  db: DbClient;
  stageStore: PdfImportStageStore;
  activeRuns: PdfImportActiveRuns;
  createAttemptId: () => string;
  now: () => Date;
  logCleanupFailure: PdfImportCleanupLogger;
}>;

export type StagePdfUploadInput = Readonly<{
  source: AsyncIterable<Uint8Array>;
  maxBytes: number;
}>;

// A streamed-but-not-yet-bound upload: the attempt id plus its stage path, content sha256, and byte
// length. The caller decides — after the identical-bytes dedup check — whether to bind a queued attempt
// or discard the stage. Kept separate from `bindStagedPdfAttempt` because the sha256 is only known AFTER
// streaming, so dedup must run between staging and the row insert.
export type StagedPdfUpload = Readonly<{
  attemptId: string;
  stagePath: string;
  sha256: string;
  byteLength: number;
}>;

// Stream the uploaded PDF into a fresh attempt-owned stage (#721), hashing as the bytes arrive so the
// whole file is never resident in memory. An oversize upload rejects with `PdfUploadTooLargeError`
// (surfaced by the stage store) and leaves no stage. No attempt row is inserted yet.
export async function stagePdfUpload(
  deps: PdfImportCommandDependencies,
  input: StagePdfUploadInput
): Promise<StagedPdfUpload> {
  const attemptId = deps.createAttemptId();
  const staged = await deps.stageStore.createStageFromStream(attemptId, input.source, {
    maxBytes: input.maxBytes
  });
  return Object.freeze({
    attemptId,
    stagePath: staged.stagePath,
    sha256: staged.sha256,
    byteLength: staged.byteLength
  });
}

export type BindStagedPdfAttemptInput = Readonly<{
  attemptId: string;
  stagePath: string;
  sha256: string;
  userId: string;
  // The resolved OCR language for this attempt (#746), frozen at queue time on the attempt row so the
  // runner and publication read the same choice for the life of the run.
  ocrLanguage: WorkLanguage;
  // An optional dependent write (e.g. #702's publication intent) committed in the SAME transaction as
  // the queued-attempt row, so the attempt is never visible/claimable by the runner without it. Any
  // throw here rolls the row back too, and the stage THIS upload created is then removed — a partial
  // start never leaves a queued attempt that would later publish as `skipped` for want of its intent.
  commitWithin?: (tx: Executor, record: PdfImportAttemptRecord) => Promise<void>;
}>;

// Bind an already-streamed stage to a fresh queued attempt row, and return its id + initial status. The
// row insert and any `commitWithin` dependent write run in one transaction, so the attempt and its
// dependent record commit atomically. If either fails, nothing is committed and the stage THIS upload
// created is rolled back — so a failed start never leaves orphaned staged bytes, never leaves a queued
// attempt missing its publication intent, and never disturbs a colliding attempt.
export async function bindStagedPdfAttempt(
  deps: PdfImportCommandDependencies,
  input: BindStagedPdfAttemptInput
): Promise<PdfImportStartedDto> {
  let record: PdfImportAttemptRecord;
  try {
    record = await deps.db.transaction(async (tx) => {
      const inserted = await insertQueuedAttempt(tx, {
        id: input.attemptId,
        userId: input.userId,
        sourceHash: input.sha256,
        stagePath: input.stagePath,
        ocrLanguage: input.ocrLanguage,
        now: deps.now()
      });
      if (input.commitWithin !== undefined) {
        await input.commitWithin(tx, inserted);
      }
      return inserted;
    });
  } catch (cause) {
    await rollbackCreatedStage(deps, input.attemptId, input.stagePath);
    throw cause;
  }

  const status = await buildPdfImportStatus(deps.db, record);
  return { attemptId: input.attemptId, status };
}

// Discard a streamed stage whose attempt was never bound: an empty upload (nothing to import) or one
// whose identical bytes already own a Work (#706 dedup), so the freshly-staged bytes are redundant. A
// removal failure is surfaced via the cleanup logger, never swallowed.
export async function discardStagedPdfUpload(
  deps: PdfImportCommandDependencies,
  input: Readonly<{ attemptId: string; stagePath: string }>
): Promise<void> {
  await rollbackCreatedStage(deps, input.attemptId, input.stagePath);
}

export type CancelPdfImportInput = Readonly<{ userId: string; attemptId: string }>;

export type PdfImportMutationResult = Readonly<{
  applied: boolean;
  status: PdfImportStatusDto | null;
}>;

// Cancel a not-yet-terminal attempt: mark it cancelled (which fences any late child output by clearing
// the run token), terminate the owned child if one is running, and remove the attempt-owned stage. A
// cleanup failure is surfaced via the cleanup logger, never swallowed.
export async function cancelPdfImport(
  deps: PdfImportCommandDependencies,
  input: CancelPdfImportInput
): Promise<PdfImportMutationResult> {
  const result = await markCancelled(deps.db, input.userId, input.attemptId, deps.now());
  if (result.cancelled) {
    if (result.wasRunning) {
      deps.activeRuns.abort(input.attemptId);
    }
    if (result.stagePath !== null) {
      await removeAndUnbindStage(deps, input.attemptId, result.stagePath);
    }
  }
  return {
    applied: result.cancelled,
    status: await statusFor(deps, input.userId, input.attemptId)
  };
}

export type RetryPdfImportInput = Readonly<{ userId: string; attemptId: string }>;

// Retry an interrupted attempt by re-queuing it; the runner resumes after the last committed range. A
// non-interrupted attempt is not retryable, so `applied` is false and its status is unchanged.
export async function retryPdfImport(
  deps: PdfImportCommandDependencies,
  input: RetryPdfImportInput
): Promise<PdfImportMutationResult> {
  const retried = await retryInterrupted(deps.db, input.userId, input.attemptId, deps.now());
  return { applied: retried, status: await statusFor(deps, input.userId, input.attemptId) };
}

async function statusFor(
  deps: PdfImportCommandDependencies,
  userId: string,
  attemptId: string
): Promise<PdfImportStatusDto | null> {
  const record = await getAttempt(deps.db, userId, attemptId);
  return record === null ? null : buildPdfImportStatus(deps.db, record);
}

export type RetryPdfImportCleanupInput = Readonly<{ userId: string; attemptId: string }>;

// Retry stage cleanup for a TERMINAL attempt whose earlier removal failed. A transient filesystem error
// during a cancel / conversion-failure / conversion-success cleanup leaves the staged bytes on disk with
// the binding still recorded (status stays `bound`) — this is the owner-scoped path that makes that
// cleanup retryable: it removes the leftover stage and, only on a successful removal, clears the binding
// (`applied: true`). A removal failure is surfaced via the cleanup logger and leaves the attempt bound so
// it can be retried again. It is a no-op (`applied: false`) when the attempt is unknown, already unbound,
// or still non-terminal — a queued / running / interrupted attempt keeps its stage on purpose (to convert
// or resume) and must never have its bytes removed here.
export async function retryPdfImportCleanup(
  deps: PdfImportCommandDependencies,
  input: RetryPdfImportCleanupInput
): Promise<PdfImportMutationResult> {
  const record = await getAttempt(deps.db, input.userId, input.attemptId);
  if (record === null) {
    return { applied: false, status: null };
  }
  if (record.stagePath === null || !isTerminalAttemptState(record.state)) {
    return { applied: false, status: await buildPdfImportStatus(deps.db, record) };
  }
  const removed = await removeAndUnbindStage(deps, input.attemptId, record.stagePath);
  return { applied: removed, status: await statusFor(deps, input.userId, input.attemptId) };
}

// Remove a terminal/cancelled attempt's stage and, ONLY on a successful removal, clear its stage binding.
// Returns whether the stage was actually removed (and the binding cleared). A removal failure is surfaced
// via the cleanup logger AND leaves `stagePath` set, so the attempt stays `bound` in status and its
// cleanup can be retried (via `retryPdfImportCleanup`) rather than the bytes lingering with no path record.
async function removeAndUnbindStage(
  deps: PdfImportCommandDependencies,
  attemptId: string,
  stagePath: string
): Promise<boolean> {
  try {
    await deps.stageStore.removeStage(stagePath);
  } catch (cause) {
    logStageCleanupFailure(deps, attemptId, stagePath, cause);
    return false;
  }
  await clearStagePath(deps.db, attemptId, deps.now());
  return true;
}

// Roll back only the stage THIS start actually created (the row insert never landed, so there is no
// binding to clear). Never touches a stagePath, so it cannot unbind a colliding attempt that owns the
// same id. A removal failure is surfaced, never swallowed.
async function rollbackCreatedStage(
  deps: PdfImportCommandDependencies,
  attemptId: string,
  stagePath: string
): Promise<void> {
  try {
    await deps.stageStore.removeStage(stagePath);
  } catch (cause) {
    logStageCleanupFailure(deps, attemptId, stagePath, cause);
  }
}

function logStageCleanupFailure(
  deps: PdfImportCommandDependencies,
  attemptId: string,
  stagePath: string,
  cause: unknown
): void {
  deps.logCleanupFailure({
    attemptId,
    stagePath,
    reason: cause instanceof Error ? cause.message : String(cause)
  });
}
