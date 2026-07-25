import { readFile, rm, stat } from "node:fs/promises";

import {
  MAX_PAGE_COUNT,
  MAX_STAGED_BYTES,
  parseRangeConversion,
  type PdfImportFailureDto,
  type ProbePage
} from "@whetstone/contracts";
import { classifyOcrRouting, nextRangeIndex, ocrPassRequired } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { formatOcrFingerprint, type PdfOcrAdapter } from "../../files/pdfOcrAdapter.js";
import { ocrStageWriteFailure } from "../../files/pdfOcrErrors.js";
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
  adoptOcrStage,
  claimNextQueued,
  clearStagePath,
  commitRange,
  getCommittedRangeIndices,
  markAwaitingReview,
  markFailed,
  setPhase,
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
  ocrAdapter: PdfOcrAdapter;
  stageStore: PdfImportStageStore;
  activeRuns: PdfImportActiveRuns;
  createRunToken: () => string;
  now: () => Date;
  pageRangeSize?: number;
  logCleanupFailure: PdfImportCleanupLogger;
}>;

export type PdfImportRunResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "awaiting_review"; attemptId: string }>
  | Readonly<{ status: "failed"; attemptId: string; failure: PdfImportFailureDto }>
  // `fenced` = the claim was superseded mid-run (cancel/interrupt): the run stops without failing the
  // attempt, since its terminal state is owned elsewhere.
  | Readonly<{ status: "fenced"; attemptId: string }>;

const DEFAULT_PAGE_RANGE_SIZE = 50;

// Both the structured-conversion (#701) and OCR (#755) boundaries return the same `{kind, what, remedy}`
// failure shape, so one projection serves both. `PdfImportFailureDto.kind` accepts any non-empty string,
// so an OCR failure kind flows through the contract unchanged.
function toFailureDto(failure: RunnerFailure): PdfImportFailureDto {
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

  // The durable OCR phase (#745), before structured conversion: decide (from the source's per-page
  // native-text classification and the Work language) whether to OCR, run the bounded pass, validate it,
  // and atomically adopt its output as the conversion source. A born-digital document, or one whose
  // language pack is not yet enabled, converts the ORIGINAL untouched. Once an OCR stage is adopted the
  // attempt resumes from the derived `ocr.pdf`.
  const source = await resolveConversionSource(
    deps,
    claimed,
    runToken,
    handle,
    stagePath,
    probed,
    signal
  );
  if (source.status !== "ok") {
    if (source.status === "fenced") {
      return { status: "fenced", attemptId: claimed.id };
    }
    return fail(deps, claimed, runToken, stagePath, source.failure);
  }
  const conversionHandle = source.handle;

  const ranges = pageRangesFor(probed.pageCount, pageRangeSize);
  const committed = await getCommittedRangeIndices(deps.db, claimed.id, fingerprint);
  // Resume after the last committed range; committed ranges are already validated and idempotent, so a
  // restart or retry never re-converts them.
  for (let index = nextRangeIndex(committed, ranges.length); index < ranges.length; index += 1) {
    if (signal.aborted) {
      return { status: "fenced", attemptId: claimed.id };
    }
    const { startPage, endPage } = ranges[index]!;
    const run = await deps.runner.convertRange(conversionHandle.path, startPage, endPage, signal);
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

  const converted = await markAwaitingReview(deps.db, claimed.id, runToken, deps.now());
  /* v8 ignore next 3 -- a supersede (cancel/interrupt) landing between the final committed range and the
     terminal write requires true concurrency; every per-range commit and the probe are already fenced
     (and covered), so this terminal guard is defensive and cannot be driven single-threaded. */
  if (!converted) {
    return { status: "fenced", attemptId: claimed.id };
  }
  // The staged bytes are RETAINED on the awaiting-review path (never removed here): they are the original
  // uploaded PDF, and publication (#702, driven by the #750 review decision) persists them through the
  // immutable source-file boundary as the Work's provenance before its own cleanup removes this
  // now-redundant stage. A failed conversion still frees its stage (see `fail`), because it never publishes.
  return { status: "awaiting_review", attemptId: claimed.id };
}

type ProbePlan = Readonly<{ status: "ok"; pageCount: number; pages: readonly ProbePage[] | null }>;

type ProbeStep =
  | ProbePlan
  | Readonly<{ status: "fenced" }>
  | Readonly<{ status: "failure"; failure: PdfStructuredFailure }>;

type ProbeReading =
  | Readonly<{ status: "ok"; pageCount: number; pages: readonly ProbePage[] }>
  | Readonly<{ status: "failure"; failure: PdfStructuredFailure }>;

// Run one probe and map its outcome to a named failure or the page plan. Shared by `ensureProbed` (the
// once-per-attempt plan probe) and the OCR routing re-probe on a resumed pre-adoption run, so both
// classify a source through exactly one probe implementation and one failure mapping.
async function readProbe(
  deps: PdfImportRunnerDependencies,
  handle: StagedFileHandle,
  signal: AbortSignal
): Promise<ProbeReading> {
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
  return { status: "ok", pageCount: probe.pageCount, pages: probe.pages };
}

// Probe the source once and persist the total page/range plan (fenced). A resumed attempt that already
// has its totals skips the probe and reuses the plan, so a restart never re-probes; it therefore returns
// `pages: null` on resume (the fresh probe pages are unavailable), and the OCR phase re-probes for
// routing only when it still needs them.
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
    return { status: "ok", pageCount: claimed.totalPages, pages: null };
  }

  const reading = await readProbe(deps, handle, signal);
  if (reading.status === "failure") {
    return reading;
  }

  const totalRanges = pageRangesFor(reading.pageCount, pageRangeSize).length;
  const applied = await setProbeResult(deps.db, {
    id: claimed.id,
    runToken,
    totalPages: reading.pageCount,
    totalRanges,
    now: deps.now()
  });
  return applied
    ? { status: "ok", pageCount: reading.pageCount, pages: reading.pages }
    : { status: "fenced" };
}

type RunnerFailure = Readonly<{ kind: string; what: string; remedy: string }>;

type ConversionSource =
  | Readonly<{ status: "ok"; handle: StagedFileHandle }>
  | Readonly<{ status: "fenced" }>
  | Readonly<{ status: "failure"; failure: RunnerFailure }>;

// Decide which staged file structured conversion reads, running the durable OCR phase when required:
//   - an attempt that already adopted an OCR stage (`ocr_fingerprint` set) resumes from the derived
//     `ocr.pdf` — the recovery boundary is crossed, so the pass never re-runs;
//   - an attempt with no adopted stage but already-committed ranges was routed `native` on its first run
//     (a text-less document adopts an OCR stage BEFORE any range commits, so a committed range with no
//     fingerprint can only be born-digital): resume converting the ORIGINAL without re-probing. Recovery
//     recomputes from the fingerprint and the committed ranges — never a re-probe — as the store contract
//     requires;
//   - otherwise (fresh run, or a resumed run that adopted nothing and committed nothing) classify routing
//     from the source's per-page native-text flags and the Work language: a born-digital document, or a
//     text-less one whose language pack is not yet enabled, converts the ORIGINAL untouched (publication
//     reports the text-less pages for the not-yet-enabled case);
//   - a text-less document in an enabled language runs one bounded OCR pass, then — only after the
//     adapter validated geometry/rotation/native-text — transfers the output into the attempt stage as
//     `ocr.pdf` and atomically adopts it (recording the fingerprint) before any range commits, so a
//     committed range always implies a settled routing decision (adopted OCR, or native).
async function resolveConversionSource(
  deps: PdfImportRunnerDependencies,
  claimed: PdfImportAttemptRecord,
  runToken: string,
  handle: StagedFileHandle,
  stagePath: string,
  probed: ProbePlan,
  signal: AbortSignal
): Promise<ConversionSource> {
  if (claimed.ocrFingerprint !== null) {
    return { status: "ok", handle: deps.stageStore.openDerivedStage(stagePath) };
  }

  // No adopted OCR stage, but ranges already committed → routed `native` on the first run; resume the
  // ORIGINAL without re-probing (recovery never re-probes once real work is committed).
  if (claimed.completedPages > 0) {
    return { status: "ok", handle };
  }

  // The OCR language is the attempt's own resolved, frozen choice (#746): the pre-import override if one
  // was chosen, otherwise the Work's own language — decided once at queue time so the runner and
  // publication never disagree and re-probing cannot drift it.
  const language = claimed.ocrLanguage;

  // Fresh run: the probe pages are in hand. Resumed pre-adoption run: re-probe the ORIGINAL for routing —
  // safe because no OCR stage has been adopted (fingerprint null), so re-probing and re-OCRing loses
  // nothing.
  let pages: readonly ProbePage[];
  if (probed.pages !== null) {
    pages = probed.pages;
  } else {
    const reading = await readProbe(deps, handle, signal);
    if (reading.status === "failure") {
      return { status: "failure", failure: reading.failure };
    }
    pages = reading.pages;
  }

  const routing = classifyOcrRouting(
    pages.map((page) => ({ pageNumber: page.pageNumber, hasNativeText: page.hasNativeText }))
  );
  if (!ocrPassRequired(routing.kind)) {
    return { status: "ok", handle };
  }

  const phased = await setPhase(deps.db, claimed.id, runToken, "ocr", deps.now());
  if (!phased) {
    return { status: "fenced" };
  }

  const outcome = await deps.ocrAdapter.execute({ source: handle, routing, language, signal });
  if (!outcome.ok) {
    // A cancelled OCR pass is a supersede, not a product failure: report it as fenced so the run stops
    // without failing the attempt (its terminal state is owned by the newer run).
    if (outcome.failure.kind === "cancelled") {
      return { status: "fenced" };
    }
    return { status: "failure", failure: outcome.failure };
  }

  // The adapter validated and transferred a caller-owned output. Copy its bytes into THIS attempt's
  // stage directory as the derived `ocr.pdf` (one cleanup surface with the immutable original), then
  // remove the now-redundant transient output — surfacing a removal failure via the cleanup logger
  // rather than aborting an otherwise-successful OCR pass, since the bytes are already durable in the
  // attempt stage.
  //
  // The read + derived-stage write is on the failure-to-data path: an unreadable transient output or a
  // failed attempt-owned write (disk/permission/missing stage dir) becomes a typed `stage_write`
  // failure so the caller marks the attempt FAILED. Rejecting here would strand the run token with the
  // attempt still `running`, blocking every later PDF import until interruption recovery on restart.
  const outputPath = outcome.result.output.path;
  let derived: StagedFileHandle;
  try {
    const bytes = new Uint8Array(await readFile(outputPath));
    derived = await deps.stageStore.writeDerivedStage(stagePath, bytes);
  } catch (cause) {
    return { status: "failure", failure: ocrStageWriteFailure(describeError(cause)) };
  }
  /* v8 ignore start -- best-effort transient cleanup: the OCR bytes are already durable in the derived
     stage by this point, so a removal failure is surfaced (never swallowed) but is not a product failure.
     Forcing `rm` to throw between the preceding `readFile` and here — without also breaking that read —
     cannot be driven deterministically across platforms, so this logging branch is exercised only in the
     field. The identical `logCleanupFailure` callback is covered on the stage-cleanup path. */
  try {
    await rm(outputPath, { force: true });
  } catch (cause) {
    deps.logCleanupFailure({
      attemptId: claimed.id,
      stagePath: outputPath,
      reason: describeError(cause)
    });
  }
  /* v8 ignore stop */

  // Atomic adoption: record the fingerprint (crossing the recovery boundary) and advance the phase to
  // `structured`. Fenced here means a newer run superseded this one after the pass; stop without failing.
  const adopted = await adoptOcrStage(
    deps.db,
    claimed.id,
    runToken,
    formatOcrFingerprint(outcome.result.fingerprint),
    deps.now()
  );
  if (!adopted) {
    return { status: "fenced" };
  }
  return { status: "ok", handle: derived };
}

// Mark the attempt failed (fenced) and free its stage. A fenced markFailed means the run was superseded,
// so it is reported as `fenced`, not `failed`. Accepts either boundary's `{kind, what, remedy}` failure.
async function fail(
  deps: PdfImportRunnerDependencies,
  claimed: PdfImportAttemptRecord,
  runToken: string,
  stagePath: string | null,
  failure: RunnerFailure
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
