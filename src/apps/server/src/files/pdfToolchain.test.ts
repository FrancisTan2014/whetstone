import { describe, expect, it } from "vitest";

import {
  PDF_MISSING_DEPENDENCY_EXIT,
  PdfToolchainMissingError,
  classifyDoclingError,
  classifyOcrError
} from "./pdfToolchain.js";

// A stand-in for a Node child-process error, which carries a `code` (string like "ENOENT" for a
// spawn failure, or a numeric exit code when the process ran and exited non-zero).
function spawnError(code: string | number): Error & { code: string | number } {
  return Object.assign(new Error(`spawn failed: ${code}`), { code });
}

describe("classifyDoclingError", () => {
  it("maps a missing binary (ENOENT) to PdfToolchainMissingError pointing at setup:pdf", () => {
    const result = classifyDoclingError(spawnError("ENOENT"));
    expect(result).toBeInstanceOf(PdfToolchainMissingError);
    expect(result.message).toContain("pnpm setup:pdf");
  });

  it("maps the worker's missing-dependency exit code to PdfToolchainMissingError", () => {
    const result = classifyDoclingError(spawnError(PDF_MISSING_DEPENDENCY_EXIT));
    expect(result).toBeInstanceOf(PdfToolchainMissingError);
  });

  it("keeps a real conversion failure (exit 4) as an ordinary error", () => {
    const cause = spawnError(4);
    expect(classifyDoclingError(cause)).toBe(cause);
    expect(classifyDoclingError(cause)).not.toBeInstanceOf(PdfToolchainMissingError);
  });

  it("wraps a non-Error rejection value in an Error", () => {
    const result = classifyDoclingError("plain string failure");
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(PdfToolchainMissingError);
    expect(result.message).toContain("plain string failure");
  });

  it("treats an error without a usable `code` as an ordinary failure (not a toolchain gap)", () => {
    // An Error with no `code`, and an object whose `code` is neither string nor number, are both
    // conversion failures, not missing-toolchain signals.
    const noCode = new Error("some conversion error");
    expect(classifyDoclingError(noCode)).toBe(noCode);

    const oddCode = classifyDoclingError({ code: { nested: true } });
    expect(oddCode).toBeInstanceOf(Error);
    expect(oddCode).not.toBeInstanceOf(PdfToolchainMissingError);
  });
});

describe("classifyOcrError", () => {
  it("maps a missing OCRmyPDF binary (ENOENT) to PdfToolchainMissingError", () => {
    const result = classifyOcrError(spawnError("ENOENT"));
    expect(result).toBeInstanceOf(PdfToolchainMissingError);
    expect(result.message).toContain("OCRmyPDF");
  });

  it("keeps a non-zero OCRmyPDF exit (a real file failure) as an ordinary error", () => {
    // Unlike Docling, an exit code is a conversion failure here (invalid_pdf), not a toolchain gap.
    const cause = spawnError(PDF_MISSING_DEPENDENCY_EXIT);
    expect(classifyOcrError(cause)).toBe(cause);
    expect(classifyOcrError(cause)).not.toBeInstanceOf(PdfToolchainMissingError);
  });

  it("wraps a non-Error rejection value in an Error", () => {
    const result = classifyOcrError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(PdfToolchainMissingError);
    expect(result.message).toContain("42");
  });
});
