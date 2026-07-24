import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTimeout } from "./withTimeout.js";
import { classifyOcrError, OCRMYPDF_MISSING_DEPENDENCY_EXIT } from "./pdfToolchain.js";

// The OCR pre-pass seam (#261): scanned PDFs carry no text layer, so before the Docling conversion
// (#15) an OCR pass adds one. It returns PDF bytes — the same shape Docling already consumes — so a
// scanned PDF joins the existing one-shot -> Markdown -> blocks funnel. Behind this interface the
// keyless gate stays green with no OCR toolchain present (the identity fake), while production spawns
// OCRmyPDF (MPL-2.0) over Tesseract (Apache-2.0) — permissive tools only — as a subprocess.
//
// The single OCRmyPDF spawn boundary lives in this module (`runOcrmypdf`). The legacy byte-in/byte-out
// pre-pass below and the bounded OCR adapter (#755) both drive that ONE spawn with different argv and
// classify its raw result themselves; there is no second spawn implementation or second binary env var.
export interface PdfOcr {
  process(bytes: Uint8Array): Promise<Uint8Array>;
}

// Identity fake: returns the input bytes unchanged, so the server boots and the gate passes with no
// OCR toolchain. A born-digital PDF already has text, so passing it through is also the correct no-op
// in production; only scanned pages need the real pass.
export function createIdentityPdfOcr(): PdfOcr {
  return Object.freeze({
    process: (bytes: Uint8Array) => Promise.resolve(bytes)
  });
}

const MAX_OCR_BUFFER_BYTES = 64 * 1024 * 1024;

// The signal used to terminate a bounded OCR child, both on our wall-clock timeout and on caller
// cancellation. SIGKILL cannot be trapped, so a hung/looping OCRmyPDF/Tesseract is always stopped.
const OCR_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";

// The raw, unclassified result of one OCRmyPDF subprocess run — a pure value each caller maps to its
// own failure taxonomy (the legacy pre-pass to a toolchain/invalid-PDF error; the #755 adapter to a
// named `PdfOcrFailure`). Keeping the spawn's outcome as data is what lets one spawn serve both.
export type OcrmypdfRunResult =
  | Readonly<{ status: "ok" }>
  | Readonly<{ status: "tool_missing" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "timed_out" }>
  | Readonly<{ status: "exit"; code: number | null; signal: NodeJS.Signals | null }>;

export type OcrmypdfInvocation = Readonly<{
  binary: string;
  args: readonly string[];
  timeoutMs: number;
  // When aborted, the child is killed and the run resolves `cancelled` — so a caller that gives up
  // never leaves an orphaned OCR process behind.
  signal?: AbortSignal;
}>;

export type RunOcrmypdf = (invocation: OcrmypdfInvocation) => Promise<OcrmypdfRunResult>;

// Pure mapping from an execFile callback error (or `null` for success) plus our own cancel flag to a
// raw run result. Unit-tested directly so `runOcrmypdf`'s only untested lines are the subprocess wiring
// (which needs a real binary). Cancellation is decided by our flag — set before we kill the child — so
// a caller-initiated abort is never mistaken for a timeout even though both terminate with a signal.
export function classifyOcrmypdfRun(
  error: ExecFileException | null,
  cancelled: boolean
): OcrmypdfRunResult {
  if (cancelled) {
    return { status: "cancelled" };
  }
  if (error === null) {
    return { status: "ok" };
  }
  if (error.code === "ENOENT") {
    return { status: "tool_missing" };
  }
  if (error.killed === true) {
    return { status: "timed_out" };
  }
  return {
    status: "exit",
    code: typeof error.code === "number" ? error.code : null,
    signal: error.signal ?? null
  };
}

// The single OCRmyPDF spawn. Both the legacy pre-pass and the #755 adapter call this; neither spawns
// OCRmyPDF itself. The wall-clock `timeout` (killSignal SIGKILL) bounds a hung pass, and an aborted
// `signal` kills the child and resolves `cancelled`.
export const runOcrmypdf: RunOcrmypdf = (invocation) =>
  new Promise<OcrmypdfRunResult>((resolve) => {
    let cancelled = false;
    const child = execFile(
      invocation.binary,
      [...invocation.args],
      {
        killSignal: OCR_KILL_SIGNAL,
        maxBuffer: MAX_OCR_BUFFER_BYTES,
        timeout: invocation.timeoutMs
      },
      (error) => resolve(classifyOcrmypdfRun(error, cancelled))
    );
    const { signal } = invocation;
    if (signal !== undefined) {
      const onAbort = (): void => {
        cancelled = true;
        try {
          child.kill(OCR_KILL_SIGNAL);
        } catch {
          // The child may have already exited or failed to spawn (e.g. a missing binary on Windows
          // rejects kill with EINVAL); the cancel flag already decided the outcome, so ignore it.
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });

// Map a failed legacy pre-pass run to the error the existing callers expect: an absent binary or
// OCRmyPDF's missing-dependency exit is a toolchain gap (→ pdf_toolchain_missing via
// PdfToolchainMissingError); anything else stays an ordinary error (→ invalid_pdf). Reuses the ONE
// `classifyOcrError` implementation rather than re-deriving the toolchain rule.
export function classifyLegacyOcrFailure(
  result: Exclude<OcrmypdfRunResult, { status: "ok" }>
): Error {
  if (result.status === "tool_missing") {
    return classifyOcrError(
      Object.assign(new Error("OCRmyPDF binary not found"), { code: "ENOENT" })
    );
  }
  if (result.status === "exit") {
    return classifyOcrError(
      Object.assign(new Error(`OCRmyPDF exited with code ${String(result.code)}`), {
        code: result.code
      })
    );
  }
  if (result.status === "timed_out") {
    return new Error("The OCR pre-pass exceeded its time ceiling and was terminated.");
  }
  return new Error("The OCR pre-pass was cancelled before it completed.");
}

export type OcrmypdfDependencies = Readonly<{
  ocrmypdfBinary: string;
  // Wall-clock bound for the OCR pre-pass. OCRmyPDF/Tesseract can be slow or hang on a large/scanned
  // PDF; without this the pre-pass runs unbounded and hangs the ingest request before the Docling
  // timeout can ever fire (#403). Sourced from config — the same bound as the Docling conversion.
  timeoutMs: number;
  // Run OCRmyPDF over the input PDF, writing the OCR'd PDF to the output path. Injected so the spawn
  // boundary is testable without a real OCRmyPDF/Tesseract install.
  run?: (inputPath: string, outputPath: string) => Promise<void>;
}>;

// The real pre-pass: write the bytes to a temp PDF, run OCRmyPDF with `--skip-text` (pages that
// already have text — a born-digital PDF — are left untouched; only image-only scanned pages get an
// OCR text layer), then return the resulting PDF bytes. The temp files live only for the pass and are
// removed after.
export function createOcrmypdfPreprocess(dependencies: OcrmypdfDependencies): PdfOcr {
  const run =
    dependencies.run ??
    (async (inputPath: string, outputPath: string) => {
      const result = await runOcrmypdf({
        binary: dependencies.ocrmypdfBinary,
        args: ["--skip-text", "--output-type", "pdf", inputPath, outputPath],
        timeoutMs: dependencies.timeoutMs
      });
      // A clean OCRmyPDF exit needs a real subprocess to observe; the failure classification is covered
      // by the missing-binary test and by classifyLegacyOcrFailure's own unit tests.
      /* v8 ignore next 2 -- success path needs a real subprocess; the failure path is covered */
      if (result.status === "ok") {
        return;
      }
      throw classifyLegacyOcrFailure(result);
    });

  return Object.freeze({
    async process(bytes: Uint8Array): Promise<Uint8Array> {
      const dir = await mkdtemp(join(tmpdir(), "whetstone-ocr-"));
      const inputPath = join(dir, "input.pdf");
      const outputPath = join(dir, "output.pdf");
      try {
        await writeFile(inputPath, bytes);
        await withTimeout(run(inputPath, outputPath), dependencies.timeoutMs, "PDF OCR pre-pass");
        return new Uint8Array(await readFile(outputPath));
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
  });
}

// Re-exported so a caller wiring the pre-pass can reference the shared missing-dependency exit code.
export { OCRMYPDF_MISSING_DEPENDENCY_EXIT };
