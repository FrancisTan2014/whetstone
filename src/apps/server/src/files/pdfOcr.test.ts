import { describe, expect, it, vi } from "vitest";
import type { ExecFileException } from "node:child_process";

import {
  classifyLegacyOcrFailure,
  classifyOcrmypdfRun,
  createIdentityPdfOcr,
  createOcrmypdfPreprocess,
  runOcrmypdf
} from "./pdfOcr.js";
import { PdfToolchainMissingError } from "./pdfToolchain.js";

// Build a synthetic execFile error so the pure classifier is tested without a real subprocess.
function execError(fields: Partial<ExecFileException>): ExecFileException {
  return Object.assign(new Error("execFile failed"), fields) as ExecFileException;
}

describe("createIdentityPdfOcr", () => {
  it("returns the input bytes unchanged, so the gate is green without an OCR toolchain", async () => {
    const ocr = createIdentityPdfOcr();
    const bytes = new Uint8Array([1, 2, 3]);

    expect(await ocr.process(bytes)).toBe(bytes);
  });
});

describe("createOcrmypdfPreprocess", () => {
  it("writes the input PDF, runs OCRmyPDF, and returns the OCR'd output bytes", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const run = vi.fn(async (inputPath: string, outputPath: string) => {
      // The input was written for the pass; the worker produces the OCR'd PDF at the output path.
      expect(inputPath.endsWith("input.pdf")).toBe(true);
      expect(outputPath.endsWith("output.pdf")).toBe(true);
      expect(new Uint8Array(await readFile(inputPath))).toEqual(new Uint8Array([0x25, 0x50]));
      await writeFile(outputPath, new Uint8Array([9, 8, 7]));
    });
    const ocr = createOcrmypdfPreprocess({ ocrmypdfBinary: "ocrmypdf", timeoutMs: 60_000, run });

    expect(await ocr.process(new Uint8Array([0x25, 0x50]))).toEqual(new Uint8Array([9, 8, 7]));
    expect(run).toHaveBeenCalledOnce();
  });

  it("cleans up the temp directory even when the OCR pass fails", async () => {
    const run = vi.fn(() => Promise.reject(new Error("ocr boom")));
    const ocr = createOcrmypdfPreprocess({ ocrmypdfBinary: "ocrmypdf", timeoutMs: 60_000, run });

    await expect(ocr.process(new Uint8Array([1]))).rejects.toThrow("ocr boom");
  });

  it("rejects at the configured timeout instead of hanging when the pre-pass never resolves (#403)", async () => {
    // A hung OCRmyPDF/Tesseract would otherwise hang the whole ingest request before the Docling
    // timeout can fire. The seam must bound the pre-pass too, so a never-settling run still rejects.
    const run = vi.fn(() => new Promise<void>(() => {}));
    const ocr = createOcrmypdfPreprocess({ ocrmypdfBinary: "ocrmypdf", timeoutMs: 20, run });

    await expect(ocr.process(new Uint8Array([1]))).rejects.toThrow(
      "PDF OCR pre-pass timed out after 20ms."
    );
  });

  it("rejects with PdfToolchainMissingError when the OCRmyPDF binary is not installed (#510)", async () => {
    // A missing binary is a toolchain gap, not a bad PDF — the spawn boundary classifies ENOENT so
    // ingestPdf can report pdf_toolchain_missing instead of invalid_pdf.
    const ocr = createOcrmypdfPreprocess({
      ocrmypdfBinary: "whetstone-no-such-ocrmypdf",
      timeoutMs: 60_000
    });

    await expect(ocr.process(new Uint8Array([1]))).rejects.toBeInstanceOf(PdfToolchainMissingError);
  });
});

describe("classifyOcrmypdfRun", () => {
  it("reports success when the child exits cleanly", () => {
    expect(classifyOcrmypdfRun(null, false)).toEqual({ status: "ok" });
  });

  it("reports tool_missing when the binary cannot be spawned (ENOENT)", () => {
    expect(classifyOcrmypdfRun(execError({ code: "ENOENT" }), false)).toEqual({
      status: "tool_missing"
    });
  });

  it("reports timed_out when the child was killed by the wall-clock timeout", () => {
    expect(classifyOcrmypdfRun(execError({ killed: true, signal: "SIGKILL" }), false)).toEqual({
      status: "timed_out"
    });
  });

  it("reports a numeric exit code with no signal for an ordinary non-zero exit", () => {
    expect(classifyOcrmypdfRun(execError({ code: 2 }), false)).toEqual({
      status: "exit",
      code: 2,
      signal: null
    });
  });

  it("reports a null code with the terminating signal when a signal (not our timeout) killed it", () => {
    expect(classifyOcrmypdfRun(execError({ signal: "SIGSEGV" }), false)).toEqual({
      status: "exit",
      code: null,
      signal: "SIGSEGV"
    });
  });

  it("reports cancelled whenever our own cancel flag is set, regardless of the error", () => {
    expect(classifyOcrmypdfRun(execError({ killed: true, signal: "SIGKILL" }), true)).toEqual({
      status: "cancelled"
    });
  });
});

describe("classifyLegacyOcrFailure", () => {
  it("maps an absent binary to a toolchain-missing error", () => {
    expect(classifyLegacyOcrFailure({ status: "tool_missing" })).toBeInstanceOf(
      PdfToolchainMissingError
    );
  });

  it("maps OCRmyPDF's missing-dependency exit (3) to a toolchain-missing error", () => {
    expect(classifyLegacyOcrFailure({ status: "exit", code: 3, signal: null })).toBeInstanceOf(
      PdfToolchainMissingError
    );
  });

  it("keeps any other non-zero exit an ordinary error (invalid_pdf), not a toolchain gap", () => {
    const error = classifyLegacyOcrFailure({ status: "exit", code: 2, signal: null });
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PdfToolchainMissingError);
  });

  it("surfaces a timeout as an ordinary error", () => {
    expect(classifyLegacyOcrFailure({ status: "timed_out" }).message).toMatch(/time ceiling/);
  });

  it("surfaces a cancellation as an ordinary error", () => {
    expect(classifyLegacyOcrFailure({ status: "cancelled" }).message).toMatch(/cancelled/);
  });
});

describe("runOcrmypdf", () => {
  it("kills the child and resolves cancelled when the signal is already aborted", async () => {
    // A pre-aborted signal exercises the synchronous kill + cancel-precedence path without a real tool.
    const result = await runOcrmypdf({
      binary: "whetstone-no-such-ocrmypdf",
      args: ["--version"],
      timeoutMs: 60_000,
      signal: AbortSignal.abort()
    });
    expect(result).toEqual({ status: "cancelled" });
  });

  it("attaches an abort listener for a live signal and still classifies a missing binary", async () => {
    // A not-yet-aborted signal exercises the addEventListener branch; the missing binary resolves first.
    const controller = new AbortController();
    const result = await runOcrmypdf({
      binary: "whetstone-no-such-ocrmypdf",
      args: ["--version"],
      timeoutMs: 60_000,
      signal: controller.signal
    });
    expect(result).toEqual({ status: "tool_missing" });
  });
});
