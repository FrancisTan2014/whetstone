import { execFile } from "node:child_process";

import type { InspectOcrToolchain, OcrToolchainAvailability } from "./pdfOcrAdapter.js";

// The runtime inspection of the OCR toolchain (#745): whether OCRmyPDF can run and which Tesseract
// trained-data packs are installed, so the bounded adapter can fail with a NAMED tool/language error
// before it ever spawns a pass. The subprocess boundary lives here; the parsing that turns tool output
// into the availability shape is pure and unit-tested, so the only untested lines are the spawn itself.

// A bounded probe of a tool: run `binary args`, resolving its exit code and combined stdout+stderr.
// `tesseract --list-langs` historically writes to stderr on some builds and stdout on others, so both
// streams are captured and concatenated for a version-independent parse. Injected so the inspector is
// testable without the real tools.
export type OcrToolProbe = (
  binary: string,
  args: readonly string[]
) => Promise<Readonly<{ code: number | null; output: string }>>;

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

// The default probe: spawn the tool, capture combined output, and never reject (a spawn failure such as
// a missing binary resolves as a non-zero code, not a throw), so the inspector always returns data.
const defaultOcrToolProbe: OcrToolProbe = (binary, args) =>
  new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { maxBuffer: MAX_TOOLCHAIN_PROBE_BYTES, timeout: TOOLCHAIN_PROBE_TIMEOUT_MS },
      /* v8 ignore next 6 -- the spawn callback needs a real binary; parsing is tested via the probe seam */
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : (error.code ?? null);
        resolve({ code: typeof code === "number" ? code : null, output: `${stdout}${stderr}` });
      }
    );
  });

export type OcrToolchainInspectorDependencies = Readonly<{
  ocrmypdfBinary: string;
  tesseractBinary: string;
  // Injected for tests; defaults to a real, bounded spawn.
  probe?: OcrToolProbe;
}>;

// Build the live toolchain inspector the production adapter injects. OCRmyPDF is checked first (a
// `--version` exit of 0 means it can run); only then are the installed Tesseract packs listed, so a
// language-pack gap is reported precisely rather than as a blanket "tool missing".
export function createOcrToolchainInspector(
  dependencies: OcrToolchainInspectorDependencies
): InspectOcrToolchain {
  const probe = dependencies.probe ?? defaultOcrToolProbe;
  return async (): Promise<OcrToolchainAvailability> => {
    const ocrmypdf = await probe(dependencies.ocrmypdfBinary, ["--version"]);
    if (ocrmypdf.code !== 0) {
      return { ocrmypdfAvailable: false, installedTraineddata: [] };
    }
    const langs = await probe(dependencies.tesseractBinary, ["--list-langs"]);
    return {
      ocrmypdfAvailable: true,
      installedTraineddata: langs.code === 0 ? parseInstalledTraineddata(langs.output) : []
    };
  };
}
