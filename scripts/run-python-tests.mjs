// Portable launcher for `pnpm test:python` -- runs every Python unittest suite in this repo.
//
// This repo has four unittest suites. Routing them all through one script (instead of hard-coding a
// discover command in package.json and again in .github/workflows/ci.yml) keeps the suite list in
// exactly one place, so CI and the npm script can never drift again (#911):
//   1. PDF worker       src/apps/server/src/files/tests        (run from the repo root)
//   2. whisper-wrapper  scripts/setup/whisper-wrapper/tests
//   3. qwen-wrapper     scripts/setup/qwen-wrapper/tests
//   4. copilot-wrapper  scripts/setup/copilot-wrapper/tests
//
// Each wrapper suite imports its package top-level (e.g. `from whetstone_whisper.cli import ...`), so
// it must be discovered with its wrapper root on `sys.path`. `python -m unittest` puts the process
// working directory on `sys.path`, so each wrapper suite is run from its own wrapper root with
// `-s tests`. Discovering a wrapper suite from the repo root (`-s scripts/setup/<w>/tests`) instead
// fails with `ModuleNotFoundError`, and passing `-t <wrapper-root>` fails with "Start directory is
// not importable" because the `tests` dirs have no `__init__.py` (both left as-is on purpose, #911).
//
// Every suite runs on the Python standard library alone -- no third-party install. The wrappers keep
// their heavy deps (faster_whisper, model runtimes) behind function-level imports, and the PDF worker
// suite mocks docling/torch via `sys.modules`, so a bare `actions/setup-python` interpreter suffices.
//
// The interpreter is resolved `python` -> `python3`, taking the first that answers `--version` with
// exit 0 (mirrors `resolvePython` in scripts/probes/pdfStructuredCorpusProbe.mjs,
// scripts/probes/pdfUsabilityHarness.mjs, and scripts/setup/steps/pdf.mjs). Many Linux/macOS hosts
// ship only `python3`, so hard-coding bare `python` in the npm script would fail `pnpm validate` /
// `pnpm test` on those boxes with `python: command not found`. CI pins `python` via actions/setup-python.
//
// All four suites run even when an earlier one fails (so a CI run surfaces every failing suite at
// once); the script exits nonzero if any suite fails, so a failing or mutated suite fails the gate.
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The single source of truth for which Python tests the gate runs. `cwd` is relative to the repo
// root; `start` is the `unittest discover -s` start directory relative to that `cwd`.
const SUITES = [
  { name: "PDF worker", cwd: ".", start: "src/apps/server/src/files/tests" },
  { name: "whisper-wrapper", cwd: "scripts/setup/whisper-wrapper", start: "tests" },
  { name: "qwen-wrapper", cwd: "scripts/setup/qwen-wrapper", start: "tests" },
  { name: "copilot-wrapper", cwd: "scripts/setup/copilot-wrapper", start: "tests" }
];

function resolvePython() {
  for (const command of ["python", "python3"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) return command;
  }
  return null;
}

const python = resolvePython();
if (python === null) {
  writeSync(
    2,
    "No Python interpreter found (tried `python`, then `python3`). Install Python 3 (e.g. `pnpm setup:pdf`) to run the Python test suites.\n"
  );
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const failed = [];

// Synchronous, direct-to-fd writes so each header lands before the inherited-stdio child's output
// (a buffered process.stdout.write would flush only after the blocking spawnSync returns).
function log(message) {
  writeSync(1, message);
}

SUITES.forEach((suite, index) => {
  log(
    `\n=== Python suite ${index + 1}/${SUITES.length}: ${suite.name} ` +
      `(discover -s ${suite.start} from ${suite.cwd}) ===\n`
  );
  const result = spawnSync(python, ["-m", "unittest", "discover", "-s", suite.start, "-v"], {
    cwd: path.join(repoRoot, suite.cwd),
    stdio: "inherit"
  });
  if (result.error) {
    writeSync(2, `Failed to launch ${python} for ${suite.name}: ${result.error.message}\n`);
    failed.push(suite.name);
  } else if (result.status !== 0) {
    failed.push(suite.name);
  }
});

if (failed.length > 0) {
  writeSync(2, `\nPython suites failed: ${failed.join(", ")}\n`);
  process.exit(1);
}
log(`\nAll ${SUITES.length} Python suites passed.\n`);
