// Distinguish a MISSING PDF TOOLCHAIN from a bad PDF (#510). PDF ingestion spawns two external
// workers — OCRmyPDF/Tesseract (the scanned-page pre-pass) and the Docling Python converter — and
// production wiring has no fake fallback, so on a host without the doc-AI lane a perfectly valid PDF
// fails to convert. That is a setup problem, not a corrupt file, and the app must surface it
// differently ("run `pnpm setup:pdf`") from a genuine invalid_pdf ("try a different file").
//
// This module owns that classification as a pure, unit-testable seam: the spawn boundaries in
// pdfToMarkdown.ts / pdfOcr.ts map a child-process failure to `PdfToolchainMissingError` when it
// signals an absent tool, and ingestPdf keys off that error type.

// The Docling worker's exit code for a missing Python dependency — kept in lockstep with
// `EXIT_MISSING_DEPENDENCY` in pdf_to_markdown.py (ImportError -> 3). A conversion failure exits 4.
export const PDF_MISSING_DEPENDENCY_EXIT = 3;

// OCRmyPDF's exit code for a missing external program it depends on — Tesseract or Ghostscript not
// found / not on PATH (its `ExitCode.missing_dependency`). Distinct from a genuine input-file/OCR
// failure (other non-zero codes), so an installed `ocrmypdf` that cannot find Tesseract is a
// toolchain gap (→ pdf_toolchain_missing), not a bad PDF (#510).
export const OCRMYPDF_MISSING_DEPENDENCY_EXIT = 3;

// Thrown when the PDF toolchain itself is absent (a binary could not be spawned, or Docling reported
// its Python dependency missing). ingestPdf maps this to `pdf_toolchain_missing` — a provisioning
// gap — instead of `invalid_pdf`.
export class PdfToolchainMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfToolchainMissingError";
  }
}

// The `code` a Node child-process error carries: a string like "ENOENT" when the binary cannot be
// spawned at all, or a numeric exit code when the process ran and exited non-zero.
function errorCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code: unknown };
    if (typeof code === "string" || typeof code === "number") {
      return code;
    }
  }
  return undefined;
}

// A spawn failure whose binary does not exist on PATH surfaces as ENOENT — the tool is not installed.
function isBinaryMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/**
 * Classify a failure from the Docling PDF converter subprocess. A missing binary (ENOENT) or the
 * worker's "Docling not installed" exit code (3) is a toolchain gap; anything else (a real
 * conversion failure, a timeout) stays a normal error the caller maps to invalid_pdf.
 */
export function classifyDoclingError(error: unknown): Error {
  if (isBinaryMissing(error) || errorCode(error) === PDF_MISSING_DEPENDENCY_EXIT) {
    return new PdfToolchainMissingError(
      "The PDF converter is not installed (Python + Docling). Run `pnpm setup:pdf` to enable PDF ingestion."
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Classify a failure from the OCRmyPDF pre-pass subprocess. A toolchain gap is either an absent
 * OCRmyPDF binary (ENOENT) OR an installed OCRmyPDF that exits with its missing-dependency code
 * because Tesseract/Ghostscript is not found (exit 3) — both mean "provision the lane", not "bad
 * file". Any other non-zero exit (a real input-file/OCR failure) stays an ordinary error (invalid_pdf).
 */
export function classifyOcrError(error: unknown): Error {
  if (isBinaryMissing(error) || errorCode(error) === OCRMYPDF_MISSING_DEPENDENCY_EXIT) {
    return new PdfToolchainMissingError(
      "The scanned-PDF OCR pre-pass (OCRmyPDF/Tesseract) is not installed, or is missing a dependency such as Tesseract. Run `pnpm setup:pdf` to enable PDF ingestion."
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
