import { describe, expect, it, vi } from "vitest";

import { createDoclingPdfToMarkdown, createFakePdfToMarkdown } from "./pdfToMarkdown.js";

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
