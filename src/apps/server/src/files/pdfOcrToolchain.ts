import { execFile } from "node:child_process";

import type { InspectOcrToolchain, OcrToolchainAvailability } from "./pdfOcrAdapter.js";

// The runtime inspection of the OCR toolchain (#745): which Tesseract trained-data packs are installed,
// so the bounded adapter can fail with a NAMED `language_missing` error before it ever spawns a pass.
// The subprocess boundary lives here; the parsing that turns tool output into the availability shape is
// pure and unit-tested, so the only untested lines are the spawn itself.
//
// It does NOT probe `ocrmypdf --version` (#797). OCRmyPDF version/pin readiness is owned by
// `pnpm setup:pdf` / setup doctor, and whether the executable can actually run is decided by the
// authoritative bounded OCR pass itself (which classifies a missing executable, a timeout, a crash, and
// cancellation). A per-import diagnostic `--version` probe on OCRmyPDF's slow Python cold start could
// exceed its own budget and reject an import whose real OCR operation would have succeeded, so it is
// removed rather than merely given a longer timeout.

// The classified outcome of a bounded tool probe. `exit` carries the process exit code and combined
// stdout+stderr; the other variants are the ways a probe can fail to yield an exit code, kept distinct so
// a slow cold start is never collapsed into "missing".
export type OcrProbeResult =
  | Readonly<{ outcome: "exit"; code: number; output: string }>
  | Readonly<{ outcome: "missing" }>
  | Readonly<{ outcome: "timed_out" }>
  | Readonly<{ outcome: "launch_failure"; detail: string }>;

// A bounded probe of a tool: run `binary args`, resolving its classified outcome (never rejecting).
// `tesseract --list-langs` historically writes to stderr on some builds and stdout on others, so both
// streams are captured and concatenated for a version-independent parse. Injected so the inspector is
// testable without the real tools.
export type OcrToolProbe = (binary: string, args: readonly string[]) => Promise<OcrProbeResult>;

const TOOLCHAIN_PROBE_TIMEOUT_MS = 15_000;
const MAX_TOOLCHAIN_PROBE_BYTES = 1024 * 1024;

// Parse `tesseract --list-langs` output into the installed pack names. The first line is a human
// header ("List of available languages (N):"); every remaining non-empty line is one pack code. Pure
// and total so it can be asserted directly against real and malformed output.
export function parseInstalledTraineddata(output: string): readonly string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^list of available languages/iu.test(line));
}

// The shape of a Node `execFile` callback error, narrowed to the fields that classify a probe outcome.
// `code` is the numeric process exit code on a clean run, or a string errno (e.g. "ENOENT") when the
// spawn itself failed; `killed` is set when Node terminated the child (here, our own timeout).
type ExecFileError = Error & { code?: string | number; killed?: boolean };

// Pure classification of a Node `execFile` result into a probe outcome. Split out from the spawn so
// every branch — timed-out, missing executable, non-zero exit, and other launch failures — is asserted
// directly with synthetic errors, no real subprocess required.
export function classifyProbeOutcome(error: ExecFileError | null, output: string): OcrProbeResult {
  if (error === null) {
    return { outcome: "exit", code: 0, output };
  }
  // Our bounded `timeout` fired and Node killed the child: the tool is present but did not answer in
  // time. This is the slow-cold-start case (#788) and must stay distinct from a missing executable.
  if (error.killed === true) {
    return { outcome: "timed_out" };
  }
  if (typeof error.code === "number") {
    return { outcome: "exit", code: error.code, output };
  }
  // A string `code` is a spawn errno: ENOENT means the executable is genuinely absent; anything else
  // (a permission error, an unexecutable file) is a launch failure, not an absence.
  if (error.code === "ENOENT") {
    return { outcome: "missing" };
  }
  return {
    outcome: "launch_failure",
    detail: typeof error.code === "string" ? error.code : error.message
  };
}

// The default probe: spawn the tool with a bounded timeout, capture combined output, and never reject —
// a spawn failure, timeout, or non-zero exit all resolve as a classified outcome so the inspector always
// returns data. Exported so a test can drive the real subprocess boundary with a present-but-slow
// executable and prove a timeout is classified as `timed_out`, not `missing` (#788).
export function createDefaultOcrToolProbe(timeoutMs: number): OcrToolProbe {
  return (binary, args) =>
    new Promise((resolve) => {
      execFile(
        binary,
        [...args],
        { maxBuffer: MAX_TOOLCHAIN_PROBE_BYTES, timeout: timeoutMs },
        (error, stdout, stderr) => {
          resolve(classifyProbeOutcome(error, `${stdout}${stderr}`));
        }
      );
    });
}

export type OcrToolchainInspectorDependencies = Readonly<{
  tesseractBinary: string;
  // The bounded readiness-probe ceiling; defaults to 15s. Injected so a test can prove the pack listing
  // is bounded without waiting the full production budget.
  timeoutMs?: number;
  // Injected for tests; defaults to a real, bounded spawn.
  probe?: OcrToolProbe;
}>;

// Build the live toolchain inspector the production adapter injects. It probes ONLY `tesseract
// --list-langs` to report the installed trained-data packs, so the adapter can reject `language_missing`
// before spawning. It does NOT probe `ocrmypdf --version` (#797): OCRmyPDF's installed/pinned readiness
// is owned by setup, and whether the executable can run is decided by the authoritative bounded pass, so
// a slow OCRmyPDF cold start can never reject a runnable import here. A Tesseract probe that does not exit
// cleanly (missing, timed out, launch failure, or a non-zero exit) yields an empty pack list rather than a
// claim that the toolchain is absent — the actual pass remains the source of truth for tool presence.
export function createOcrToolchainInspector(
  dependencies: OcrToolchainInspectorDependencies
): InspectOcrToolchain {
  const probe =
    dependencies.probe ??
    createDefaultOcrToolProbe(dependencies.timeoutMs ?? TOOLCHAIN_PROBE_TIMEOUT_MS);
  return async (): Promise<OcrToolchainAvailability> => {
    const langs = await probe(dependencies.tesseractBinary, ["--list-langs"]);
    return {
      status: "available",
      installedTraineddata:
        langs.outcome === "exit" && langs.code === 0 ? parseInstalledTraineddata(langs.output) : []
    };
  };
}
