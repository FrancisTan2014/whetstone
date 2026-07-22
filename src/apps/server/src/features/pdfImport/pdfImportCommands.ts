import type { PdfImportStartedDto, PdfImportStatusDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import { hashBytes } from "../../files/sourceFileStore.js";
import type { PdfImportCleanupLogger, PdfImportActiveRuns } from "./pdfImportRunner.js";
import { buildPdfImportStatus } from "./pdfImportQueries.js";
import type { PdfImportStageStore } from "./pdfImportStage.js";
import {
  getAttempt,
  insertQueuedAttempt,
  markCancelled,
  retryInterrupted
} from "./pdfImportStore.js";

// The owner-scoped start / cancel / retry commands for a recoverable staged PDF import (#721). These own
// the stage lifecycle boundary: start creates and atomically binds the stage before the attempt is
// queued; cancel terminates the owned child, fences late output (via the store), and removes the stage;
// retry re-queues an interrupted attempt to resume. None of them create a Work, ReadingUnit, or Block —
// publication is #702.

export type PdfImportCommandDependencies = Readonly<{
  db: DbClient;
  stageStore: PdfImportStageStore;
  activeRuns: PdfImportActiveRuns;
  createAttemptId: () => string;
  now: () => Date;
  logCleanupFailure: PdfImportCleanupLogger;
}>;

export type StartPdfImportInput = Readonly<{ userId: string; bytes: Uint8Array }>;

// Stage the uploaded bytes, bind them to a fresh queued attempt, and return its id + initial status. The
// stage is created BEFORE the row and rolled back if the bind insert fails, so a failed start never
// leaves orphaned staged bytes and a queued attempt always owns a real stage.
export async function startPdfImport(
  deps: PdfImportCommandDependencies,
  input: StartPdfImportInput
): Promise<PdfImportStartedDto> {
  const attemptId = deps.createAttemptId();
  const sourceHash = hashBytes(input.bytes);
  const { stagePath } = await deps.stageStore.createStage(attemptId, input.bytes);

  let record;
  try {
    record = await insertQueuedAttempt(deps.db, {
      id: attemptId,
      userId: input.userId,
      sourceHash,
      stagePath,
      now: deps.now()
    });
  } catch (cause) {
    await removeStageQuiet(deps, attemptId, stagePath);
    throw cause;
  }

  const status = await buildPdfImportStatus(deps.db, record);
  return { attemptId, status };
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
      await removeStageQuiet(deps, input.attemptId, result.stagePath);
    }
  }
  return { applied: result.cancelled, status: await statusFor(deps, input.userId, input.attemptId) };
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

async function removeStageQuiet(
  deps: PdfImportCommandDependencies,
  attemptId: string,
  stagePath: string
): Promise<void> {
  try {
    await deps.stageStore.removeStage(stagePath);
  } catch (cause) {
    deps.logCleanupFailure({
      attemptId,
      stagePath,
      reason: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
