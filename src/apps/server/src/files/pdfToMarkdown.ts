import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PdfOcr } from "./pdfOcr.js";

// The PDF-to-Markdown seam (#15): PDF ingestion converges on the existing Markdown -> mdast ->
// decompose -> blocks pipeline. Conversion is one-shot — a born-digital PDF is rendered to clean
// Markdown — behind this interface so the keyless gate builds and stays green with no Python present
// (the fake), while production spawns the isolated Docling worker (MIT, permissive) as a subprocess.
export interface PdfToMarkdown {
  convert(bytes: Uint8Array): Promise<string>;
}

// Deterministic fake: returns canned Markdown regardless of input, so the server boots and the gate
// passes with no Python toolchain. Admin review before persist still applies — the fake just supplies
// the Markdown the same pipeline would otherwise receive.
export function createFakePdfToMarkdown(markdown: string): PdfToMarkdown {
  return Object.freeze({
    convert: () => Promise.resolve(markdown)
  });
}

export type DoclingDependencies = Readonly<{
  // Run the converter script: python interpreter + script path, given the temp PDF path; returns
  // Markdown on stdout. Injected so the spawn boundary is testable without a real Python install.
  run?: (pdfPath: string) => Promise<string>;
  pythonBinary: string;
  scriptPath: string;
  // Wall-clock bound for the conversion. Docling is slow on large/scanned PDFs; without this an
  // oversized book runs unbounded and hangs the ingest request (#403). Sourced from config.
  timeoutMs: number;
}>;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Reject if `work` does not settle within `timeoutMs`, so the seam bounds any converter — the real
// spawn (killed via execFile's own timeout) and an injected run alike. The timer is always cleared,
// so a resolved conversion leaves no dangling handle.
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`PDF conversion timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// The real worker: write the bytes to a temp file, spawn the one-shot Docling script, return its
// Markdown. The PDF lives only for the conversion and is removed after. Permissive deps only.
export function createDoclingPdfToMarkdown(dependencies: DoclingDependencies): PdfToMarkdown {
  const run =
    dependencies.run ??
    ((pdfPath: string) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          dependencies.pythonBinary,
          [dependencies.scriptPath, pdfPath],
          // Bound the subprocess itself: on timeout execFile sends killSignal, so a slow/oversized
          // PDF is killed (not abandoned) and the callback rejects → route maps it to 422 (#403).
          { killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES, timeout: dependencies.timeoutMs },
          /* v8 ignore next -- success path needs a real subprocess; failure path is covered */
          (error, stdout) => (error === null ? resolve(stdout) : reject(error))
        );
      }));

  return Object.freeze({
    async convert(bytes: Uint8Array): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "whetstone-pdf-"));
      const pdfPath = join(dir, "source.pdf");
      try {
        await writeFile(pdfPath, bytes);
        return await withTimeout(run(pdfPath), dependencies.timeoutMs);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
  });
}

// Compose an OCR pre-pass (#261) ahead of a PDF-to-Markdown converter: the bytes are OCR'd first
// (adding a text layer to scanned pages; a no-op for born-digital text), then converted. A scanned
// PDF therefore reaches the same Markdown -> blocks funnel as a born-digital one.
export function composePdfToMarkdown(ocr: PdfOcr, inner: PdfToMarkdown): PdfToMarkdown {
  return Object.freeze({
    async convert(bytes: Uint8Array): Promise<string> {
      const ocrated = await ocr.process(bytes);
      return inner.convert(ocrated);
    }
  });
}
