import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
}>;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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
          { maxBuffer: MAX_OUTPUT_BYTES },
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
        return await run(pdfPath);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
  });
}
