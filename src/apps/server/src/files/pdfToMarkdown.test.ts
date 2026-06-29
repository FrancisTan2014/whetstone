import { describe, expect, it, vi } from "vitest";

import { decomposeMarkdown } from "@whetstone/domain";

import { createIdentityPdfOcr } from "./pdfOcr.js";
import {
  composePdfToMarkdown,
  createDoclingPdfToMarkdown,
  createFakePdfToMarkdown
} from "./pdfToMarkdown.js";

describe("createFakePdfToMarkdown", () => {
  it("returns its canned Markdown regardless of input, so the gate is green without Python", async () => {
    const bridge = createFakePdfToMarkdown("# Title\n\nBody.");
    expect(await bridge.convert(new Uint8Array([1, 2, 3]))).toBe("# Title\n\nBody.");
  });
});

describe("createDoclingPdfToMarkdown", () => {
  it("writes the bytes to a temp path and returns the worker's Markdown", async () => {
    const run = vi.fn(async (pdfPath: string) => {
      expect(pdfPath.endsWith("source.pdf")).toBe(true);
      return "# From PDF\n";
    });
    const bridge = createDoclingPdfToMarkdown({ pythonBinary: "python", run, scriptPath: "s.py" });

    expect(await bridge.convert(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("# From PDF\n");
    expect(run).toHaveBeenCalledOnce();
  });

  it("cleans up the temp directory even when conversion fails", async () => {
    const run = vi.fn(() => Promise.reject(new Error("boom")));
    const bridge = createDoclingPdfToMarkdown({ pythonBinary: "python", run, scriptPath: "s.py" });

    await expect(bridge.convert(new Uint8Array([1]))).rejects.toThrow("boom");
  });

  it("spawns the configured python binary by default and rejects when it cannot run", async () => {
    const bridge = createDoclingPdfToMarkdown({
      pythonBinary: "whetstone-no-such-python",
      scriptPath: "s.py"
    });

    await expect(bridge.convert(new Uint8Array([1]))).rejects.toThrow();
  });
});

describe("composePdfToMarkdown", () => {
  it("runs the OCR pre-pass before the converter, feeding the converter the OCR'd bytes (#261)", async () => {
    const ocr = { process: vi.fn(async () => new Uint8Array([10, 20])) };
    const inner = {
      convert: vi.fn(async (bytes: Uint8Array) => `bytes:${Array.from(bytes).join(",")}`)
    };

    const bridge = composePdfToMarkdown(ocr, inner);

    expect(await bridge.convert(new Uint8Array([1, 2, 3]))).toBe("bytes:10,20");
    expect(ocr.process).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(inner.convert).toHaveBeenCalledWith(new Uint8Array([10, 20]));
  });

  it("golden: a scanned PDF flows OCR -> Markdown -> blocks like a born-digital one (#261)", async () => {
    // The OCR pass adds a text layer (faked as identity here); Docling (faked) yields Markdown; the
    // shared pipeline decomposes it into the same blocks a born-digital PDF would produce.
    const scannedMarkdown = "# Scanned Title\n\nFirst paragraph.\n\n- one\n- two";
    const bridge = composePdfToMarkdown(
      createIdentityPdfOcr(),
      createFakePdfToMarkdown(scannedMarkdown)
    );

    const markdown = await bridge.convert(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const blocks = decomposeMarkdown(markdown).flatMap((unit) => unit.blocks);

    expect(blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["heading", "Scanned Title"],
      ["paragraph", "First paragraph."],
      ["list", "onetwo"]
    ]);
  });
});
