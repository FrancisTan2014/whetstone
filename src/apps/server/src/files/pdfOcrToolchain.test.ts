import { describe, expect, it } from "vitest";

import {
  createOcrToolchainInspector,
  parseInstalledTraineddata,
  type OcrToolProbe
} from "./pdfOcrToolchain.js";

describe("parseInstalledTraineddata", () => {
  it("strips the human header and returns each remaining pack code, trimmed", () => {
    const output = "List of available languages (3):\neng\n chi_sim \nosd\n";
    expect(parseInstalledTraineddata(output)).toEqual(["eng", "chi_sim", "osd"]);
  });

  it("tolerates CRLF line endings and a case-varied header", () => {
    expect(parseInstalledTraineddata("LIST OF AVAILABLE LANGUAGES (1):\r\neng\r\n")).toEqual(["eng"]);
  });

  it("returns no packs for empty or header-only output", () => {
    expect(parseInstalledTraineddata("")).toEqual([]);
    expect(parseInstalledTraineddata("List of available languages (0):\n\n")).toEqual([]);
  });
});

// A probe seam that returns canned results per binary and records the binaries it was asked to run, so a
// test can prove Tesseract is only consulted after OCRmyPDF reports it can run.
function recordingProbe(
  results: Readonly<Record<string, { code: number | null; output: string }>>
): OcrToolProbe & { calls: string[] } {
  const calls: string[] = [];
  const probe = ((binary: string) => {
    calls.push(binary);
    return Promise.resolve(results[binary] ?? { code: 127, output: "" });
  }) as OcrToolProbe & { calls: string[] };
  probe.calls = calls;
  return probe;
}

describe("createOcrToolchainInspector", () => {
  it("reports the installed packs when OCRmyPDF runs and Tesseract lists languages", async () => {
    const probe = recordingProbe({
      ocrmypdf: { code: 0, output: "16.10.4" },
      tesseract: { code: 0, output: "List of available languages (2):\neng\nosd\n" }
    });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({ ocrmypdfAvailable: true, installedTraineddata: ["eng", "osd"] });
    expect(probe.calls).toEqual(["ocrmypdf", "tesseract"]);
  });

  it("short-circuits without probing Tesseract when OCRmyPDF cannot run", async () => {
    const probe = recordingProbe({ ocrmypdf: { code: 127, output: "not found" } });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({ ocrmypdfAvailable: false, installedTraineddata: [] });
    expect(probe.calls).toEqual(["ocrmypdf"]);
  });

  it("reports OCRmyPDF available but no packs when the language list itself fails", async () => {
    const probe = recordingProbe({
      ocrmypdf: { code: 0, output: "16.10.4" },
      tesseract: { code: 1, output: "boom" }
    });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({ ocrmypdfAvailable: true, installedTraineddata: [] });
  });

  it("defaults to a real spawn that reports a missing binary as unavailable", async () => {
    // No probe injected: the default bounded spawn runs against a binary that cannot exist, so it resolves
    // (never rejects) as a non-zero code and the toolchain is reported unavailable rather than throwing.
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "whetstone-no-such-ocr-binary",
      tesseractBinary: "whetstone-no-such-tesseract-binary"
    });
    expect(await inspect()).toEqual({ ocrmypdfAvailable: false, installedTraineddata: [] });
  });
});
