import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The OCR pre-pass seam (#261): scanned PDFs carry no text layer, so before the Docling conversion
// (#15) an OCR pass adds one. It returns PDF bytes — the same shape Docling already consumes — so a
// scanned PDF joins the existing one-shot -> Markdown -> blocks funnel. Behind this interface the
// keyless gate stays green with no OCR toolchain present (the identity fake), while production spawns
// OCRmyPDF (MPL-2.0) over Tesseract (Apache-2.0) — permissive tools only — as a subprocess.
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

export type OcrmypdfDependencies = Readonly<{
  ocrmypdfBinary: string;
  // Run OCRmyPDF over the input PDF, writing the OCR'd PDF to the output path. Injected so the spawn
  // boundary is testable without a real OCRmyPDF/Tesseract install.
  run?: (inputPath: string, outputPath: string) => Promise<void>;
}>;

const MAX_OCR_BUFFER_BYTES = 64 * 1024 * 1024;

// The real pre-pass: write the bytes to a temp PDF, run OCRmyPDF with `--skip-text` (pages that
// already have text — a born-digital PDF — are left untouched; only image-only scanned pages get an
// OCR text layer), then return the resulting PDF bytes. The temp files live only for the pass and are
// removed after.
export function createOcrmypdfPreprocess(dependencies: OcrmypdfDependencies): PdfOcr {
  const run =
    dependencies.run ??
    ((inputPath: string, outputPath: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          dependencies.ocrmypdfBinary,
          ["--skip-text", "--output-type", "pdf", inputPath, outputPath],
          { maxBuffer: MAX_OCR_BUFFER_BYTES },
          /* v8 ignore next -- success path needs a real subprocess; the failure path is covered */
          (error) => (error === null ? resolve() : reject(error))
        );
      }));

  return Object.freeze({
    async process(bytes: Uint8Array): Promise<Uint8Array> {
      const dir = await mkdtemp(join(tmpdir(), "whetstone-ocr-"));
      const inputPath = join(dir, "input.pdf");
      const outputPath = join(dir, "output.pdf");
      try {
        await writeFile(inputPath, bytes);
        await run(inputPath, outputPath);
        return new Uint8Array(await readFile(outputPath));
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
  });
}
