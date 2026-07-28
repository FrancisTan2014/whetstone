// Named failures for the bounded PDF OCR adapter (#755). Every way the adapter can decline to return a
// validated OCR output stage is one of these tagged values, each carrying an actionable `remedy` —
// never a bare Error or a silent null. The adapter returns them as data (a discriminated union) so the
// boundary tests can assert every path and the first consumer (#745) can branch on `kind` without
// string-matching messages.
//
// This mirrors the structured adapter's `pdfStructuredErrors.ts` pattern deliberately: a single tagged
// failure type plus pure constructors, so the risky classification is unit-testable without a
// subprocess.

import type { OcrmypdfRunResult } from "./pdfOcr.js";

const SETUP_REMEDY = "Run `pnpm setup:pdf` to provision the pinned OCRmyPDF/Tesseract toolchain.";

export type PdfOcrFailureKind =
  | "tool_missing"
  | "tool_unresponsive"
  | "language_missing"
  | "unsupported_input"
  | "routing_mismatch"
  | "timeout"
  | "memory"
  | "child_crash"
  | "cancelled"
  | "geometry"
  | "native_text"
  | "output_validation"
  | "stage_write"
  | "cleanup";

export type PdfOcrFailure = Readonly<{
  kind: PdfOcrFailureKind;
  what: string;
  remedy: string;
}>;

export function ocrToolMissingFailure(): PdfOcrFailure {
  return Object.freeze({
    kind: "tool_missing",
    what: "The PDF OCR toolchain (OCRmyPDF over Tesseract) is not installed or not on PATH.",
    remedy: SETUP_REMEDY
  });
}

// The OCRmyPDF executable IS present, but its bounded readiness probe did not complete cleanly (#788):
// the `--version` probe timed out (a slow Windows cold start), failed to launch, or exited non-zero.
// This must NEVER be reported as `tool_missing` — the tool is installed, so the setup/install remedy is
// wrong and misleading. It is a truthful, retryable failure: the same import can succeed on a later
// attempt once the tool warms up, without any reinstall.
const READINESS_REASON_DETAIL: Readonly<Record<string, string>> = {
  timeout: "the OCRmyPDF readiness probe (`--version`) exceeded its time budget",
  launch_failure: "the OCRmyPDF readiness probe could not be launched",
  version_probe_failed: "OCRmyPDF is present but its `--version` readiness probe exited abnormally"
};

export function ocrToolUnresponsiveFailure(
  reason: "timeout" | "launch_failure" | "version_probe_failed",
  detail: string
): PdfOcrFailure {
  return Object.freeze({
    kind: "tool_unresponsive",
    what: `OCRmyPDF is installed but did not become ready in time: ${READINESS_REASON_DETAIL[reason] ?? reason} (${detail}).`,
    remedy:
      "This is usually a slow cold start, not a missing tool. Wait a moment and start the import again — no reinstall is needed."
  });
}

export function ocrLanguageMissingFailure(missingPacks: readonly string[]): PdfOcrFailure {
  return Object.freeze({
    kind: "language_missing",
    what: `Tesseract is missing the trained-data pack(s) required for this language: ${missingPacks.join(", ")}.`,
    remedy: `Install the Tesseract language pack(s) ${missingPacks.join(", ")} (for example via the pinned setup), then retry.`
  });
}

export function ocrUnsupportedInputFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "unsupported_input",
    what: `The staged PDF could not be OCR'd because the OCR tool rejected the input: ${detail}`,
    remedy: "Provide a valid, unencrypted PDF, then re-stage it."
  });
}

// The caller's routing decision (#704) disagrees with the routing the adapter re-derives from its own
// fresh before-probe of the immutable source. Trusting a stale/mismatched decision would let a scanned
// or mixed source be reported as validated OCR without processing every page the adapter itself
// classified as text-less, so the pass is refused before running or copying anything.
export function ocrRoutingMismatchFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "routing_mismatch",
    what: `The supplied OCR routing decision does not match the source the adapter just probed: ${detail}`,
    remedy:
      "Re-derive the routing decision from a fresh probe of the immutable source (classifyOcrRouting), then retry — do not reuse a stale decision."
  });
}

export function ocrTimeoutFailure(timeoutMs: number): PdfOcrFailure {
  return Object.freeze({
    kind: "timeout",
    what: `The OCR pass exceeded the ${timeoutMs}ms ceiling and its child process was terminated.`,
    remedy: "Raise the OCR time ceiling, or split the document into smaller parts."
  });
}

export function ocrMemoryFailure(): PdfOcrFailure {
  return Object.freeze({
    kind: "memory",
    what: "The OCR child process was killed after exhausting memory.",
    remedy: "Raise the memory available to the OCR pass, or OCR the document in smaller parts."
  });
}

export function ocrChildCrashFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "child_crash",
    what: `The OCR child process exited abnormally: ${detail}`,
    remedy: "Re-run the OCR pass; if it recurs, re-provision the toolchain with `pnpm setup:pdf`."
  });
}

export function ocrCancelledFailure(): PdfOcrFailure {
  return Object.freeze({
    kind: "cancelled",
    what: "The OCR pass was cancelled before it completed.",
    remedy: "Start the OCR pass again when ready."
  });
}

export function ocrGeometryFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "geometry",
    what: `The OCR pass altered the source page geometry, so its output is not a faithful overlay: ${detail}`,
    remedy:
      "Do not re-ingest this output. Re-run with the pinned toolchain; if it persists, the source needs manual correction."
  });
}

export function ocrNativeTextFailure(pageNumber: number): PdfOcrFailure {
  return Object.freeze({
    kind: "native_text",
    what: `The OCR pass lost the native text on page ${pageNumber}, which must be preserved.`,
    remedy:
      "Do not re-ingest this output. Re-run with `--skip-text`; if it persists, re-provision the pinned toolchain."
  });
}

export function ocrOutputValidationFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "output_validation",
    what: `The OCR pass produced an output PDF that could not be re-probed: ${detail}`,
    remedy: "Re-run the OCR pass; if it recurs, re-provision the toolchain with `pnpm setup:pdf`."
  });
}

// The adapter validated the OCR output, but the runner could not copy it into the attempt-owned
// derived stage: the transient output was unreadable, or the derived-stage write failed (disk,
// permission, or a missing stage directory). Surfaced as a typed failure so the attempt is marked
// failed rather than left running — a rejection here would strand the run token and block every later
// PDF import until interruption recovery on the next restart.
export function ocrStageWriteFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "stage_write",
    what: `The OCR pass validated its output, but it could not be copied into the attempt's stage: ${detail}`,
    remedy: "Free disk space/permission on the server stage directory, then start the import again."
  });
}

export function ocrCleanupFailure(detail: string): PdfOcrFailure {
  return Object.freeze({
    kind: "cleanup",
    what: `The OCR pass finished but its temporary working files could not be removed: ${detail}`,
    remedy:
      "Free disk space/permission on the server temp directory; the validated output is retained."
  });
}

// OCRmyPDF's stable process exit codes (its `ExitCode` enum). Kept here as the single source that maps
// a real OCR run's exit to a named adapter failure, so no caller re-implements this classification.
// https://ocrmypdf.readthedocs.io/en/latest/advanced.html#return-code-policy
export const OCRMYPDF_EXIT_BAD_ARGS = 1;
export const OCRMYPDF_EXIT_INPUT_FILE = 2;
export const OCRMYPDF_EXIT_MISSING_DEPENDENCY = 3;
export const OCRMYPDF_EXIT_INVALID_OUTPUT_PDF = 4;
export const OCRMYPDF_EXIT_FILE_ACCESS_ERROR = 5;
export const OCRMYPDF_EXIT_ALREADY_DONE = 6;
export const OCRMYPDF_EXIT_CHILD_PROCESS_ERROR = 7;
export const OCRMYPDF_EXIT_ENCRYPTED_PDF = 8;
export const OCRMYPDF_EXIT_INVALID_CONFIG = 9;
export const OCRMYPDF_EXIT_PDFA_CONVERSION_FAILED = 10;
export const OCRMYPDF_EXIT_OTHER_ERROR = 15;

// Pure classification of a non-`ok` OCRmyPDF run into the matching adapter failure. Split out from the
// adapter so every branch is unit-tested without a real subprocess; the adapter only calls this once.
export function classifyOcrmypdfFailure(
  result: Exclude<OcrmypdfRunResult, { status: "ok" }>,
  timeoutMs: number
): PdfOcrFailure {
  switch (result.status) {
    case "tool_missing":
      return ocrToolMissingFailure();
    case "timed_out":
      return ocrTimeoutFailure(timeoutMs);
    case "cancelled":
      return ocrCancelledFailure();
    case "exit":
      return classifyOcrmypdfExit(result.code, result.signal);
  }
}

function classifyOcrmypdfExit(code: number | null, signal: NodeJS.Signals | null): PdfOcrFailure {
  // A child killed by the OS (a signal, with no exit code) that was not our own timeout/cancel — most
  // commonly an out-of-memory kill — is surfaced as a memory failure rather than a generic crash.
  if (code === null) {
    return signal === null
      ? ocrChildCrashFailure("the child exited without a code or signal")
      : signal === "SIGKILL"
        ? ocrMemoryFailure()
        : ocrChildCrashFailure(`terminated by signal ${signal}`);
  }
  switch (code) {
    case OCRMYPDF_EXIT_MISSING_DEPENDENCY:
      return ocrToolMissingFailure();
    case OCRMYPDF_EXIT_INPUT_FILE:
    case OCRMYPDF_EXIT_ENCRYPTED_PDF:
      return ocrUnsupportedInputFailure(`OCRmyPDF exit code ${code}`);
    case OCRMYPDF_EXIT_INVALID_OUTPUT_PDF:
    case OCRMYPDF_EXIT_PDFA_CONVERSION_FAILED:
      return ocrOutputValidationFailure(`OCRmyPDF exit code ${code}`);
    default:
      // Bad args, file access, already-done, child-process, invalid config, other — none of which a
      // correctly-invoked bounded pass should hit, so they are an abnormal child crash to investigate.
      return ocrChildCrashFailure(`OCRmyPDF exit code ${code}`);
  }
}
