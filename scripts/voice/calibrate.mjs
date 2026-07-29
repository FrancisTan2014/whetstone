#!/usr/bin/env node
// `pnpm calibrate:voice [manifest.json]` — a thin launcher for the provider-neutral voice calibration
// gate (#800). It resolves the configured local speech provider (LOCAL_ASR_BINARY + LOCAL_ASR_MODEL) from
// the root `.env` and runs the bundled `whetstone_qwen.calibrate` module through the managed venv's Python
// over a LOCAL clip manifest, printing only aggregate metrics (micro-CER / WER, cold duration, peak RSS)
// and a pass/fail gate. Audio, references, and transcripts never leave the machine and are never printed.
//
// This is a developer/maintainer tool, not part of `pnpm setup`, so it lives outside `scripts/setup/` and
// is intentionally not coverage-gated: the calibration LOGIC (scoring, aggregation, the gate, and the
// privacy guarantee) is unit-tested in the Python package; this launcher only wires paths together and
// fails loud with an actionable message.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_MANIFEST = resolve(REPO_ROOT, ".data/voice/calibration/manifest.json");

/**
 * Fail loud with a concrete remedy, then exit non-zero.
 *
 * @param {string} what
 * @param {string} remedy
 * @returns {never}
 */
function fail(what, remedy) {
  console.error(`\n[calibrate:voice] ${what}\n  → ${remedy}\n`);
  process.exit(1);
}

/**
 * Parse simple `KEY=value` lines from `.env` (comments ignored), mirroring the setup env-file reader.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnv(content) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of content.split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      vars[match[1]] = match[2].trim();
    }
  }
  return vars;
}

const envPath = resolve(REPO_ROOT, ".env");
if (!existsSync(envPath)) {
  fail(
    "No .env was found, so the local speech provider is not configured.",
    "Run `pnpm setup:voice` to install the bundled Qwen3-ASR provider, then re-run `pnpm calibrate:voice`."
  );
}

const env = parseEnv(readFileSync(envPath, "utf8"));
const binary = env.LOCAL_ASR_BINARY;
const model = env.LOCAL_ASR_MODEL;
if (!binary || !model) {
  fail(
    "LOCAL_ASR_BINARY / LOCAL_ASR_MODEL are not both set in .env.",
    "Run `pnpm setup:voice` to install the bundled Qwen3-ASR provider (it writes both), then re-run."
  );
}

const venvPython =
  process.platform === "win32"
    ? resolve(REPO_ROOT, ".data/voice/qwen-venv/Scripts/python.exe")
    : resolve(REPO_ROOT, ".data/voice/qwen-venv/bin/python");
if (!existsSync(venvPython)) {
  fail(
    `The managed voice runtime interpreter is missing (${venvPython}).`,
    "Run `pnpm setup:voice` to provision the isolated Qwen3-ASR virtual environment, then re-run."
  );
}

const manifest = resolve(REPO_ROOT, process.argv[2] ?? DEFAULT_MANIFEST);
if (!existsSync(manifest)) {
  fail(
    `The calibration manifest was not found (${manifest}).`,
    "Pass a manifest path (`pnpm calibrate:voice path/to/manifest.json`) or place one at " +
      "`.data/voice/calibration/manifest.json`. See docs/SPEECH.md for its format."
  );
}

const result = spawnSync(
  venvPython,
  ["-m", "whetstone_qwen.calibrate", "--binary", binary, "--model", model, "--manifest", manifest],
  { cwd: REPO_ROOT, stdio: "inherit" }
);
process.exit(result.status ?? 1);
