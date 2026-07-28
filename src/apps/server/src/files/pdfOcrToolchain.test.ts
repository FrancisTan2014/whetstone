import { describe, expect, it } from "vitest";

import {
  classifyProbeOutcome,
  createDefaultOcrToolProbe,
  createOcrToolchainInspector,
  parseInstalledTraineddata,
  type OcrProbeResult,
  type OcrToolProbe
} from "./pdfOcrToolchain.js";

describe("parseInstalledTraineddata", () => {
  it("strips the human header and returns each remaining pack code, trimmed", () => {
    const output = "List of available languages (3):\neng\n chi_sim \nosd\n";
    expect(parseInstalledTraineddata(output)).toEqual(["eng", "chi_sim", "osd"]);
  });

  it("tolerates CRLF line endings and a case-varied header", () => {
    expect(parseInstalledTraineddata("LIST OF AVAILABLE LANGUAGES (1):\r\neng\r\n")).toEqual([
      "eng"
    ]);
  });

  it("returns no packs for empty or header-only output", () => {
    expect(parseInstalledTraineddata("")).toEqual([]);
    expect(parseInstalledTraineddata("List of available languages (0):\n\n")).toEqual([]);
  });
});

describe("classifyProbeOutcome", () => {
  it("maps a null error (clean run) to exit code 0 with the captured output", () => {
    expect(classifyProbeOutcome(null, "16.10.4")).toEqual({
      outcome: "exit",
      code: 0,
      output: "16.10.4"
    });
  });

  it("maps a killed child (our timeout) to timed_out, never missing", () => {
    // A present-but-slow executable Node terminated on the bounded timeout: `killed` is set and there is
    // no numeric exit code. This must NOT be read as a missing executable (#788).
    const error = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
    expect(classifyProbeOutcome(error, "")).toEqual({ outcome: "timed_out" });
  });

  it("maps a numeric exit code to exit with that code", () => {
    const error = Object.assign(new Error("nonzero"), { code: 2 });
    expect(classifyProbeOutcome(error, "boom")).toEqual({
      outcome: "exit",
      code: 2,
      output: "boom"
    });
  });

  it("maps an ENOENT spawn error to missing", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(classifyProbeOutcome(error, "")).toEqual({ outcome: "missing" });
  });

  it("maps a non-ENOENT spawn errno to a launch failure carrying the errno", () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(classifyProbeOutcome(error, "")).toEqual({
      outcome: "launch_failure",
      detail: "EACCES"
    });
  });

  it("falls back to the error message for a launch failure with no errno code", () => {
    const error = new Error("mysterious launch failure");
    expect(classifyProbeOutcome(error, "")).toEqual({
      outcome: "launch_failure",
      detail: "mysterious launch failure"
    });
  });
});

// A probe seam that returns canned outcomes per binary and records the binaries it was asked to run, so a
// test can prove Tesseract is only consulted after OCRmyPDF reports it can run.
function recordingProbe(
  results: Readonly<Record<string, OcrProbeResult>>
): OcrToolProbe & { calls: string[] } {
  const calls: string[] = [];
  const probe = ((binary: string) => {
    calls.push(binary);
    return Promise.resolve(results[binary] ?? { outcome: "missing" });
  }) as OcrToolProbe & { calls: string[] };
  probe.calls = calls;
  return probe;
}

describe("createOcrToolchainInspector", () => {
  it("reports the installed packs when OCRmyPDF runs and Tesseract lists languages", async () => {
    const probe = recordingProbe({
      ocrmypdf: { outcome: "exit", code: 0, output: "16.10.4" },
      tesseract: {
        outcome: "exit",
        code: 0,
        output: "List of available languages (2):\neng\nosd\n"
      }
    });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({
      status: "available",
      installedTraineddata: ["eng", "osd"]
    });
    expect(probe.calls).toEqual(["ocrmypdf", "tesseract"]);
  });

  it("reports OCRmyPDF available but no packs when the language list itself fails", async () => {
    const probe = recordingProbe({
      ocrmypdf: { outcome: "exit", code: 0, output: "16.10.4" },
      tesseract: { outcome: "exit", code: 1, output: "boom" }
    });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({ status: "available", installedTraineddata: [] });
  });

  it("reports missing (never unresponsive) when the OCRmyPDF executable is genuinely absent", async () => {
    const probe = recordingProbe({ ocrmypdf: { outcome: "missing" } });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({ status: "missing" });
    // Tesseract is never consulted once OCRmyPDF cannot run.
    expect(probe.calls).toEqual(["ocrmypdf"]);
  });

  it("reports a distinct timeout readiness failure — NOT missing — for a present but slow OCRmyPDF", async () => {
    // The bug (#788): a present OCRmyPDF whose `--version` probe is killed on the bounded timeout was
    // collapsed into "unavailable" and surfaced as tool_missing. It must be its own outcome.
    const probe = recordingProbe({ ocrmypdf: { outcome: "timed_out" } });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({
      status: "unresponsive",
      reason: "timeout",
      detail: "the OCRmyPDF `--version` probe timed out"
    });
    expect(probe.calls).toEqual(["ocrmypdf"]);
  });

  it("reports a launch failure as unresponsive, carrying the errno detail", async () => {
    const probe = recordingProbe({
      ocrmypdf: { outcome: "launch_failure", detail: "EACCES" }
    });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({
      status: "unresponsive",
      reason: "launch_failure",
      detail: "EACCES"
    });
  });

  it("reports a non-zero --version exit as unresponsive (present, but not confirmed ready)", async () => {
    const probe = recordingProbe({
      ocrmypdf: { outcome: "exit", code: 3, output: "startup error" }
    });
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "ocrmypdf",
      tesseractBinary: "tesseract",
      probe
    });
    expect(await inspect()).toEqual({
      status: "unresponsive",
      reason: "version_probe_failed",
      detail: "ocrmypdf --version exited 3"
    });
    expect(probe.calls).toEqual(["ocrmypdf"]);
  });
});

describe("createOcrToolchainInspector — real bounded spawn", () => {
  it("classifies a genuinely missing binary as status: missing", async () => {
    const inspect = createOcrToolchainInspector({
      ocrmypdfBinary: "whetstone-no-such-ocr-binary",
      tesseractBinary: "whetstone-no-such-tesseract-binary"
    });
    expect(await inspect()).toEqual({ status: "missing" });
  });
});

describe("createDefaultOcrToolProbe — real subprocess boundary", () => {
  // Drive the real spawn so the subprocess callback (and classifyProbeOutcome through it) is exercised
  // end to end against genuinely present and absent executables.

  it("classifies a present but slow executable as timed_out, never missing", async () => {
    // A real, present executable (this Node runtime) that deliberately sleeps far longer than the bounded
    // probe budget. On current main a killed probe carries no exit code and was collapsed into
    // "unavailable" → tool_missing; the fix classifies it as `timed_out` (#788).
    const probe = createDefaultOcrToolProbe(150);
    const result = await probe(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    expect(result).toEqual({ outcome: "timed_out" });
  }, 10_000);

  it("classifies a genuinely missing executable as missing", async () => {
    const probe = createDefaultOcrToolProbe(10_000);
    expect(await probe("whetstone-no-such-binary", ["--version"])).toEqual({ outcome: "missing" });
  });

  it("classifies a present, fast executable as a clean exit with its output", async () => {
    const probe = createDefaultOcrToolProbe(10_000);
    const result = await probe(process.execPath, ["-e", "process.stdout.write('16.10.4')"]);
    expect(result).toEqual({ outcome: "exit", code: 0, output: "16.10.4" });
  }, 10_000);
});
