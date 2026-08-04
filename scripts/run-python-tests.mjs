// Portable launcher for `pnpm test:python` (the PDF worker unit suite).
//
// It resolves the Python interpreter the same way every other Python entry point in this repo does:
// try `python`, then `python3`, taking the first that answers `--version` with exit 0 (mirrors
// `resolvePython` in scripts/probes/pdfStructuredCorpusProbe.mjs, scripts/probes/pdfUsabilityHarness.mjs,
// and scripts/setup/steps/pdf.mjs). Many Linux/macOS hosts ship only `python3`, so hard-coding bare
// `python` in the npm script would fail `pnpm validate` / `pnpm test` on those boxes with
// `python: command not found`. CI pins `python` via actions/setup-python and can invoke it directly.
//
// All CLI args are forwarded verbatim to the resolved interpreter with inherited stdio, and its exit
// code is propagated, so a failing test run (or a mutated worker) fails the gate.
import { spawnSync } from "node:child_process";

function resolvePython() {
  for (const command of ["python", "python3"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) return command;
  }
  return null;
}

const python = resolvePython();
if (python === null) {
  process.stderr.write(
    "No Python interpreter found (tried `python`, then `python3`). Install Python 3 (e.g. `pnpm setup:pdf`) to run the PDF worker tests.\n"
  );
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`Failed to launch ${python}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
