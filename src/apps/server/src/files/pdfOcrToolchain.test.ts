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
// test can prove the inspector only consults Tesseract and never probes OCRmyPDF's `--version` (#797).
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
  it("reports the installed packs from Tesseract, without ever probing OCRmyPDF's --version (#797)", async () => {
    const probe = recordingProbe({
      tesseract: {
        outcome: "exit",
        code: 0,
        output: "List of available languages (2):\neng\nosd\n"
      }
    });
    const inspect = createOcrToolchainInspector({ tesseractBinary: "tesseract", probe });
    expect(await inspect()).toEqual({
      status: "available",
      installedTraineddata: ["eng", "osd"]
    });
    // Only Tesseract is consulted: the redundant per-import `ocrmypdf --version` gate is gone.
    expect(probe.calls).toEqual(["tesseract"]);
    expect(probe.calls).not.toContain("ocrmypdf");
  });

  it("reports available with no packs when the Tesseract language list itself fails", async () => {
    const probe = recordingProbe({
      tesseract: { outcome: "exit", code: 1, output: "boom" }
    });
    const inspect = createOcrToolchainInspector({ tesseractBinary: "tesseract", probe });
    expect(await inspect()).toEqual({ status: "available", installedTraineddata: [] });
  });

  it("reports available with no packs (never a tool-presence claim) when the Tesseract probe does not exit cleanly", async () => {
    // A missing, timed-out, or launch-failing Tesseract probe yields an empty pack list — never a claim
    // that the whole toolchain is absent. The actual bounded OCR pass remains the source of truth for
    // whether OCRmyPDF can run, so a slow diagnostic never rejects a runnable import (#797).
    for (const outcome of [
      { outcome: "missing" },
      { outcome: "timed_out" },
      { outcome: "launch_failure", detail: "EACCES" }
    ] as const) {
      const probe = recordingProbe({ tesseract: outcome });
      const inspect = createOcrToolchainInspector({ tesseractBinary: "tesseract", probe });
      expect(await inspect()).toEqual({ status: "available", installedTraineddata: [] });
      expect(probe.calls).toEqual(["tesseract"]);
    }
  });
});

describe("createOcrToolchainInspector — real bounded spawn", () => {
  it("reports available with no packs for a genuinely missing Tesseract binary, never probing OCRmyPDF", async () => {
    const inspect = createOcrToolchainInspector({
      tesseractBinary: "whetstone-no-such-tesseract-binary"
    });
    expect(await inspect()).toEqual({ status: "available", installedTraineddata: [] });
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
