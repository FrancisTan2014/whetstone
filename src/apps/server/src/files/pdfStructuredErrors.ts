// Named failures for the bounded structured PDF adapter (#701). Every way the adapter can decline to
// produce a validated structured result is one of these tagged values, each carrying an actionable
// `remedy` — never a bare Error or a silent null. The adapter returns them as data (a discriminated
// union) so the boundary tests can assert every path and a later consumer (#721) can branch on `kind`
// without string-matching messages.

// Exit codes the Python worker (pdf_to_docling.py) uses to self-classify a failure it detects inside
// the child process. Kept in LOCKSTEP with the worker: changing one side requires changing the other.
// A bare non-zero exit with no recognized code is treated as a child crash.
export const WORKER_EXIT_USAGE = 2;
export const WORKER_EXIT_MISSING_DEPENDENCY = 3;
export const WORKER_EXIT_CONVERSION_FAILED = 4;
export const WORKER_EXIT_PASSWORD_REQUIRED = 5;
export const WORKER_EXIT_UNSUPPORTED_SCHEMA = 6;
export const WORKER_EXIT_MEMORY = 7;

const SETUP_REMEDY = "Run `pnpm setup:pdf` to provision the pinned Docling runtime and models.";

export type PdfStructuredFailureKind =
  | "too_large"
  | "too_many_pages"
  | "password_required"
  | "malformed"
  | "unsupported_schema"
  | "tool_missing"
  | "timeout"
  | "memory"
  | "child_crash"
  | "cancelled"
  | "cleanup";

export type PdfStructuredFailure = Readonly<{
  kind: PdfStructuredFailureKind;
  what: string;
  remedy: string;
}>;

export function tooLargeFailure(byteLength: number, limitBytes: number): PdfStructuredFailure {
  return Object.freeze({
    kind: "too_large",
    what: `The staged PDF is ${byteLength} bytes, above the ${limitBytes}-byte (128 MiB) limit.`,
    remedy: "Split or shrink the document below 128 MiB, then re-stage it."
  });
}

export function tooManyPagesFailure(pageCount: number, limitPages: number): PdfStructuredFailure {
  return Object.freeze({
    kind: "too_many_pages",
    what: `The staged PDF has ${pageCount} pages, above the ${limitPages}-page limit.`,
    remedy: "Split the document into parts under 3,000 pages, then re-stage each part."
  });
}

export function passwordRequiredFailure(): PdfStructuredFailure {
  return Object.freeze({
    kind: "password_required",
    what: "The PDF is encrypted and cannot be opened without a password.",
    remedy: "Remove the password/permissions, export an unencrypted copy, then re-stage it."
  });
}

export function malformedFailure(detail: string): PdfStructuredFailure {
  return Object.freeze({
    kind: "malformed",
    what: `The PDF could not be parsed into a structured document: ${detail}`,
    remedy: "Confirm the file is a valid, non-corrupt PDF, then re-stage it."
  });
}

export function unsupportedSchemaFailure(version: string): PdfStructuredFailure {
  return Object.freeze({
    kind: "unsupported_schema",
    what: `The converter emitted DoclingDocument schema version "${version}", which this adapter does not support.`,
    remedy: SETUP_REMEDY
  });
}

export function toolMissingFailure(): PdfStructuredFailure {
  return Object.freeze({
    kind: "tool_missing",
    what: "The PDF converter (Python + pinned Docling/docling-core + models) is not available.",
    remedy: SETUP_REMEDY
  });
}

export function timeoutFailure(timeoutMs: number): PdfStructuredFailure {
  return Object.freeze({
    kind: "timeout",
    what: `A page range exceeded the ${timeoutMs}ms conversion ceiling and was terminated.`,
    remedy: "Raise the per-range time ceiling, or split the document into smaller page ranges."
  });
}

export function memoryFailure(): PdfStructuredFailure {
  return Object.freeze({
    kind: "memory",
    what: "The conversion child process exceeded its memory ceiling and was terminated.",
    remedy: "Raise the memory ceiling, or convert the document in smaller page ranges."
  });
}

export function childCrashFailure(detail: string): PdfStructuredFailure {
  return Object.freeze({
    kind: "child_crash",
    what: `The conversion child process exited abnormally: ${detail}`,
    remedy: "Re-run the import; if it recurs, re-provision the toolchain with `pnpm setup:pdf`."
  });
}

export function cancelledFailure(): PdfStructuredFailure {
  return Object.freeze({
    kind: "cancelled",
    what: "The conversion was cancelled before it completed.",
    remedy: "Start the import again when ready."
  });
}

export function cleanupFailure(detail: string): PdfStructuredFailure {
  return Object.freeze({
    kind: "cleanup",
    what: `The conversion finished but its temporary working files could not be removed: ${detail}`,
    remedy:
      "Free disk/permission on the server temp directory; the staged source is left for retry."
  });
}

// Pure classification of how a single child-process range run ended into the matching failure. The
// adapter's own wall-clock guard reports `timedOut`; an aborted signal reports `cancelled`; otherwise
// the worker's self-classifying exit code (or a terminating signal) decides. Unit-tested directly so
// the spawn boundary's success path is the only line that needs a real subprocess.
export function classifyWorkerExit(outcome: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  timeoutMs: number;
}): PdfStructuredFailure {
  if (outcome.cancelled) {
    return cancelledFailure();
  }
  if (outcome.timedOut) {
    return timeoutFailure(outcome.timeoutMs);
  }
  switch (outcome.code) {
    case WORKER_EXIT_MISSING_DEPENDENCY:
      return toolMissingFailure();
    case WORKER_EXIT_PASSWORD_REQUIRED:
      return passwordRequiredFailure();
    case WORKER_EXIT_UNSUPPORTED_SCHEMA:
      return unsupportedSchemaFailure("unreported");
    case WORKER_EXIT_MEMORY:
      return memoryFailure();
    case WORKER_EXIT_CONVERSION_FAILED:
    case WORKER_EXIT_USAGE:
      return malformedFailure(`worker exited with code ${outcome.code}`);
    default:
      return childCrashFailure(
        outcome.signal === null
          ? `exit code ${String(outcome.code)}`
          : `terminated by signal ${outcome.signal}`
      );
  }
}
