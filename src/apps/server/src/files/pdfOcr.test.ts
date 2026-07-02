import { describe, expect, it, vi } from "vitest";

import { createIdentityPdfOcr, createOcrmypdfPreprocess } from "./pdfOcr.js";

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

  it("spawns the configured binary by default and rejects when it cannot run", async () => {
    const ocr = createOcrmypdfPreprocess({
      ocrmypdfBinary: "whetstone-no-such-ocrmypdf",
      timeoutMs: 60_000
    });

    await expect(ocr.process(new Uint8Array([1]))).rejects.toThrow();
  });
});
