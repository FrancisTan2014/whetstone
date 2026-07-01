// Optional setup step (first consumer of the #346 framework): enable local Whisper STT with one
// command — `pnpm setup --voice`. It installs faster-whisper + the `whetstone-whisper` console-script
// wrapper, pre-fetches the model, and writes WHISPER_BINARY / WHISPER_MODEL_PATH / WHISPER_LANGUAGE to
// the root `.env` (which the server dev/start already load). Excluded from the base `pnpm setup`
// (heavy/network); every failure mode returns an actionable { what, remedy }, never a raw crash.

import { fileURLToPath } from "node:url";

import { error, missing, ok, withOutputTail } from "../step.mjs";

const DEFAULT_MODEL = "small";
const WRAPPER_DIR = fileURLToPath(new URL("../whisper-wrapper", import.meta.url));
const SAMPLE_AUDIO = fileURLToPath(new URL("./voice-sample.wav", import.meta.url));

const PYTHON_REMEDY =
  "Install Python 3 (https://www.python.org/downloads, or `winget install Python.Python.3` / " +
  "`brew install python`), then re-run `pnpm setup --voice`.";

/**
 * Parse simple `KEY=value` lines from a `.env` file's contents (commented lines ignored).
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvVars(content) {
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

/**
 * Upsert `KEY=value` entries into `.env` contents: an existing active *or commented* `KEY=` line is
 * rewritten in place (uncommenting the `.env.example` template line), otherwise the entry is
 * appended. Entries with an `undefined` value are skipped. Always returns newline-terminated content.
 *
 * @param {string} content
 * @param {Record<string, string | undefined>} vars
 * @returns {string}
 */
export function upsertEnvVars(content, vars) {
  const handled = new Set();
  const lines = (content.length === 0 ? [] : content.split("\n")).map((line) => {
    const match = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (match && vars[match[1]] !== undefined) {
      handled.add(match[1]);
      return `${match[1]}=${vars[match[1]]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined && !handled.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) {
    out += "\n";
  }
  return out;
}

/**
 * Check that stdout is the docs/SPEECH.md contract shape (a string `text` + an array `segments`).
 *
 * @param {string} stdout
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function parseContractShape(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "output was not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "output was not a JSON object" };
  }
  if (typeof parsed.text !== "string") {
    return { ok: false, reason: 'missing string "text"' };
  }
  if (!Array.isArray(parsed.segments)) {
    return { ok: false, reason: 'missing array "segments"' };
  }
  return { ok: true };
}

/**
 * Resolve an available Python interpreter command, or null when none is on PATH.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string | null}
 */
function resolvePython(ctx) {
  for (const command of ["python", "python3"]) {
    if (ctx.exec(command, ["--version"]).code === 0) {
      return command;
    }
  }
  return null;
}

/**
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {Record<string, string>}
 */
function readEnv(ctx) {
  const path = envPath(ctx);
  return ctx.fs.exists(path) ? parseEnvVars(ctx.fs.readText(path)) : {};
}

/**
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string}
 */
function envPath(ctx) {
  return `${ctx.root}/.env`;
}

/** @type {import("../step.mjs").Step} */
export const voiceStep = {
  id: "voice",
  title: "Voice input (local Whisper STT)",
  optional: true,
  capability: "voice",
  check(ctx) {
    const python = resolvePython(ctx);
    if (python === null) {
      return missing("Python 3 was not found (required for local Whisper STT).", PYTHON_REMEDY);
    }
    if (ctx.exec(python, ["-c", "import faster_whisper"]).code !== 0) {
      return missing(
        "faster-whisper is not installed.",
        "Run `pnpm setup --voice` to install it and wire up Whisper."
      );
    }
    const env = readEnv(ctx);
    if (env.WHISPER_BINARY === undefined || env.WHISPER_MODEL_PATH === undefined) {
      return missing(
        "Whisper is not wired into .env (WHISPER_BINARY / WHISPER_MODEL_PATH).",
        "Run `pnpm setup --voice`."
      );
    }
    if (!ctx.fs.exists(env.WHISPER_BINARY)) {
      return missing(
        `The whetstone-whisper launcher is missing (${env.WHISPER_BINARY}).`,
        "Run `pnpm setup --voice` to reinstall it."
      );
    }
    return ok();
  },
  provision(ctx) {
    const python = resolvePython(ctx);
    if (python === null) {
      return missing("Python 3 was not found (required for local Whisper STT).", PYTHON_REMEDY);
    }

    const pip = ctx.exec(python, ["-m", "pip", "install", "faster-whisper"]);
    if (pip.code !== 0) {
      return error(
        "`pip install faster-whisper` failed.",
        withOutputTail(
          "Ensure pip is available (`python -m ensurepip --upgrade`) and check your network/proxy, then re-run `pnpm setup --voice`.",
          pip
        )
      );
    }

    const wrapper = ctx.exec(python, ["-m", "pip", "install", WRAPPER_DIR]);
    if (wrapper.code !== 0) {
      return error(
        "Installing the whetstone-whisper wrapper failed.",
        withOutputTail("Re-run `pnpm setup --voice` and inspect the pip error above.", wrapper)
      );
    }

    const located = ctx.exec(python, ["-m", "whetstone_whisper.locate"]);
    const launcher = located.stdout.trim();
    if (located.code !== 0 || launcher.length === 0) {
      return error(
        "The whetstone-whisper launcher could not be located after installation.",
        "Ensure your Python scripts directory is on PATH, then re-run `pnpm setup --voice`."
      );
    }

    const model = ctx.env.WHISPER_MODEL ?? DEFAULT_MODEL;
    const fetched = ctx.exec(python, ["-m", "whetstone_whisper.fetch", model]);
    if (fetched.code !== 0) {
      return error(
        `Downloading the Whisper model "${model}" failed.`,
        withOutputTail(
          "Retry, pick a smaller model (`WHISPER_MODEL=base.en pnpm setup --voice`), or check connectivity.",
          fetched
        )
      );
    }

    const path = envPath(ctx);
    const content = ctx.fs.exists(path) ? ctx.fs.readText(path) : "";
    ctx.fs.writeText(
      path,
      upsertEnvVars(content, {
        WHISPER_BINARY: launcher,
        WHISPER_MODEL_PATH: model,
        WHISPER_LANGUAGE: ctx.env.WHISPER_LANGUAGE
      })
    );
    return ok();
  },
  verify(ctx) {
    const env = readEnv(ctx);
    if (env.WHISPER_BINARY === undefined || env.WHISPER_MODEL_PATH === undefined) {
      return error(
        "Whisper is not wired into .env after provisioning.",
        "Re-run `pnpm setup --voice`."
      );
    }
    const result = ctx.exec(env.WHISPER_BINARY, [
      "--model",
      env.WHISPER_MODEL_PATH,
      "--language",
      env.WHISPER_LANGUAGE ?? "en",
      "--output",
      "json",
      "--word-timestamps",
      SAMPLE_AUDIO
    ]);
    if (result.code !== 0) {
      return error(
        "The whetstone-whisper wrapper failed on the sample audio.",
        withOutputTail(
          "See docs/SPEECH.md and check the model; then re-run `pnpm setup --voice`.",
          result
        )
      );
    }
    const shape = parseContractShape(result.stdout);
    if (!shape.ok) {
      return error(
        `The wrapper emitted off-contract output: ${shape.reason}.`,
        withOutputTail("See docs/SPEECH.md and check the model.", result)
      );
    }
    return ok();
  }
};
