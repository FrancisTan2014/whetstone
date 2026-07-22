import { stat } from "node:fs/promises";

import {
  MAX_PAGE_COUNT,
  MAX_STAGED_BYTES,
  parseRangeConversion,
  type PdfImportFailureDto
} from "@whetstone/contracts";
import { nextRangeIndex } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import {
  pageRangesFor,
  type DoclingRunner,
  type StagedFileHandle
} from "../../files/pdfStructuredAdapter.js";
import {
  malformedFailure,
  passwordRequiredFailure,
  toolMissingFailure,
  tooLargeFailure,
  tooManyPagesFailure,
  unsupportedSchemaFailure,
  type PdfStructuredFailure
} from "../../files/pdfStructuredErrors.js";
import type { PdfImportStageStore } from "./pdfImportStage.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  clearStagePath,
  commitRange,
  getCommittedRangeIndices,
  markConverted,
  markFailed,
  setProbeResult,
  type PdfImportAttemptRecord
} from "./pdfImportStore.js";

// The conversion runner (#721): the one background worker that drives a claimed attempt through #701's
// range primitives, checkpointing each validated range so a crash, cancel, or interrupt loses no more
// than the range in flight. It never publishes content — `converted` only records that every range
// passed validation. Single admission is enforced by the store's claim; every write is run-token fenced
// there, so a superseded child stops the moment its checkpoint is refused.

// A tagged cleanup-failure log so a stage that could not be removed after a terminal outcome stays
// VISIBLE (never silently swallowed), matching the "cleanup failures surface" rule.
export type PdfImportCleanupLogger = (
  event: Readonly<{ attemptId: string; stagePath: string; reason: string }>
) => void;

// The in-process registry of the single active conversion's abort handle, so cancellation can terminate
// the owned child. Keyed by attempt id and fenced by run token so a stale `clear` from a finished run
// never drops a newer run's controller. Internals stay private (no mutable map is exposed).
export type PdfImportActiveRuns = Readonly<{
  register: (attemptId: string, runToken: string, controller: AbortController) => void;
  abort: (attemptId: string) => void;
  clear: (attemptId: string, runToken: string) => void;
}>;

export function createPdfImportActiveRuns(): PdfImportActiveRuns {
  const runs = new Map<string, Readonly<{ runToken: string; controller: AbortController }>>();
  return Object.freeze({
    register(attemptId, runToken, controller) {
      runs.set(attemptId, { runToken, controller });
    },
    abort(attemptId) {
      runs.get(attemptId)?.controller.abort();
    },
    clear(attemptId, runToken) {
      if (runs.get(attemptId)?.runToken === runToken) {
        runs.delete(attemptId);
      }
    }
  });
}

export type PdfImportRunnerDependencies = Readonly<{
  db: DbClient;
  runner: DoclingRunner;
  stageStore: PdfImportStageStore;
  activeRuns: PdfImportActiveRuns;
  createRunToken: () => string;
  now: () => Date;
  pageRangeSize?: number;
  logCleanupFailure: PdfImportCleanupLogger;
}>;

export type PdfImportRunResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "converted"; attemptId: string }>
  | Readonly<{ status: "failed"; attemptId: string; failure: PdfImportFailureDto }>
  // `fenced` = the claim was superseded mid-run (cancel/interrupt): the run stops without failing the
  // attempt, since its terminal state is owned elsewhere.
  | Readonly<{ status: "fenced"; attemptId: string }>;

const DEFAULT_PAGE_RANGE_SIZE = 50;

function toFailureDto(failure: PdfStructuredFailure): PdfImportFailureDto {
  return { kind: failure.kind, message: failure.what, remedy: failure.remedy };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Claim the single slot for the oldest queued attempt and convert it. Returns `idle` when nothing is
// queued or the slot is already held. Never rejects: every failure mode is returned as data.
export async function processNextPdfImport(
  deps: PdfImportRunnerDependencies
): Promise<PdfImportRunResult> {
  const runToken = deps.createRunToken();
  const claimed = await claimNextQueued(deps.db, {
    runToken,
    fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
    now: deps.now()
  });
  if (claimed === null) {
    return { status: "idle" };
  }

  const controller = new AbortController();
  deps.activeRuns.register(claimed.id, runToken, controller);
  try {
    return await convertClaimed(deps, claimed, runToken, controller.signal);
  } finally {
    deps.activeRuns.clear(claimed.id, runToken);
  }
}

async function convertClaimed(
  deps: PdfImportRunnerDependencies,
  claimed: PdfImportAttemptRecord,
  runToken: string,
  signal: AbortSignal
): Promise<PdfImportRunResult> {
  const pageRangeSize = deps.pageRangeSize ?? DEFAULT_PAGE_RANGE_SIZE;
  const fingerprint = PDF_IMPORT_ADAPTER_FINGERPRINT;

  // A queued attempt always owns a bound stage; a null stage path is a corrupted claim, not a crash.
  if (claimed.stagePath === null) {
    return fail(deps, claimed, runToken, null, malformedFailure("the attempt has no bound stage."));
  }
  const stagePath = claimed.stagePath;

  let handle: StagedFileHandle;
  try {
    handle = deps.stageStore.openStage(stagePath);
  } catch (cause) {
    return fail(deps, claimed, runToken, stagePath, malformedFailure(describeError(cause)));
  }

  // Bound the staged bytes from stat first (a missing/unreadable stage is a failure, not a crash), so
  // an oversized or vanished stage is a named failure before any child spawns.
  let byteLength: number;
  try {
    byteLength = (await stat(handle.path)).size;
  } catch (cause) {
    return fail(
      deps,
      claimed,
      runToken,
      stagePath,
      malformedFailure(`staged file could not be read: ${describeError(cause)}`)
    );
  }
  if (byteLength > MAX_STAGED_BYTES) {
    return fail(deps, claimed, runToken, stagePath, tooLargeFailure(byteLength, MAX_STAGED_BYTES));
  }

  const probed = await ensureProbed(deps, claimed, runToken, handle, pageRangeSize, signal);
  if (probed.status !== "ok") {
    if (probed.status === "fenced") {
      return { status: "fenced", attemptId: claimed.id };
    }
    return fail(deps, claimed, runToken, stagePath, probed.failure);
  }

  const ranges = pageRangesFor(probed.pageCount, pageRangeSize);
  const committed = await getCommittedRangeIndices(deps.db, claimed.id, fingerprint);
  // Resume after the last committed range; committed ranges are already validated and idempotent, so a
  // restart or retry never re-converts them.
  for (let index = nextRangeIndex(committed, ranges.length); index < ranges.length; index += 1) {
    if (signal.aborted) {
      return { status: "fenced", attemptId: claimed.id };
    }
    const { startPage, endPage } = ranges[index]!;
    const run = await deps.runner.convertRange(handle.path, startPage, endPage, signal);
    if (run.status === "failure") {
      if (run.failure.kind === "cancelled") {
        return { status: "fenced", attemptId: claimed.id };
      }
      return fail(deps, claimed, runToken, stagePath, run.failure);
    }
    const parsed = parseRangeConversion(run.raw);
    if (parsed.status === "malformed") {
      return fail(deps, claimed, runToken, stagePath, malformedFailure(parsed.detail));
    }
    if (parsed.status === "unsupported_schema") {
      return fail(deps, claimed, runToken, stagePath, unsupportedSchemaFailure(parsed.version));
    }
    const applied = await commitRange(deps.db, {
      attemptId: claimed.id,
      runToken,
      rangeIndex: index,
      startPage,
      endPage,
      fingerprint,
      payload: parsed.value,
      now: deps.now()
    });
    if (!applied) {
      return { status: "fenced", attemptId: claimed.id };
    }
  }

  const converted = await markConverted(deps.db, claimed.id, runToken, deps.now());
  /* v8 ignore next 3 -- a supersede (cancel/interrupt) landing between the final committed range and the
     terminal write requires true concurrency; every per-range commit and the probe are already fenced
     (and covered), so this terminal guard is defensive and cannot be driven single-threaded. */
  if (!converted) {
    return { status: "fenced", attemptId: claimed.id };
  }
  await removeStageVisible(deps, claimed.id, stagePath);
  return { status: "converted", attemptId: claimed.id };
}

type ProbeStep =
  | Readonly<{ status: "ok"; pageCount: number }>
  | Readonly<{ status: "fenced" }>
  | Readonly<{ status: "failure"; failure: PdfStructuredFailure }>;

// Probe the source once and persist the total page/range plan (fenced). A resumed attempt that already
// has its totals skips the probe and reuses the plan, so a restart never re-probes.
async function ensureProbed(
  deps: PdfImportRunnerDependencies,
  claimed: PdfImportAttemptRecord,
  runToken: string,
  handle: StagedFileHandle,
  pageRangeSize: number,
  signal: AbortSignal
): Promise<ProbeStep> {
  // A resumed attempt that already has its probe totals skips the probe and reuses the plan; totalPages
  // and totalRanges are always persisted together by `setProbeResult`, so testing totalPages alone is
  // sufficient (and keeps the resume decision a single branch).
  if (claimed.totalPages !== null) {
    return { status: "ok", pageCount: claimed.totalPages };
  }

  const probe = await deps.runner.probe(handle.path, signal);
  if (probe.status === "tool_missing") {
    return { status: "failure", failure: toolMissingFailure() };
  }
  if (probe.status === "password_required") {
    return { status: "failure", failure: passwordRequiredFailure() };
  }
  if (probe.status === "malformed") {
    return { status: "failure", failure: malformedFailure(probe.detail) };
  }
  if (probe.pageCount > MAX_PAGE_COUNT) {
    return { status: "failure", failure: tooManyPagesFailure(probe.pageCount, MAX_PAGE_COUNT) };
  }

  const totalRanges = pageRangesFor(probe.pageCount, pageRangeSize).length;
  const applied = await setProbeResult(deps.db, {
    id: claimed.id,
    runToken,
    totalPages: probe.pageCount,
    totalRanges,
    now: deps.now()
  });
  return applied ? { status: "ok", pageCount: probe.pageCount } : { status: "fenced" };
}

// Mark the attempt failed (fenced) and free its stage. A fenced markFailed means the run was superseded,
// so it is reported as `fenced`, not `failed`.
async function fail(
  deps: PdfImportRunnerDependencies,
  claimed: PdfImportAttemptRecord,
  runToken: string,
  stagePath: string | null,
  failure: PdfStructuredFailure
): Promise<PdfImportRunResult> {
  const dto = toFailureDto(failure);
  const applied = await markFailed(deps.db, claimed.id, runToken, dto, deps.now());
  if (!applied) {
    return { status: "fenced", attemptId: claimed.id };
  }
  if (stagePath !== null) {
    await removeStageVisible(deps, claimed.id, stagePath);
  }
  return { status: "failed", attemptId: claimed.id, failure: dto };
}

// Remove the attempt-owned stage after a terminal outcome and, ONLY on success, clear the stage binding
// so status reports it unbound. A removal failure is surfaced via the cleanup logger (never swallowed)
// AND leaves `stagePath` set, so the attempt stays `bound` in status and its cleanup can be retried
// rather than the bytes lingering with no record of the path.
async function removeStageVisible(
  deps: PdfImportRunnerDependencies,
  attemptId: string,
  stagePath: string
): Promise<void> {
  try {
    await deps.stageStore.removeStage(stagePath);
  } catch (cause) {
    deps.logCleanupFailure({ attemptId, stagePath, reason: describeError(cause) });
    return;
  }
  await clearStagePath(deps.db, attemptId, deps.now());
}
