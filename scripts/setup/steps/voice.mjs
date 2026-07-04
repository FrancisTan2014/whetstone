// Optional setup step (first consumer of the #346 framework): enable local Whisper STT with one
// command — `pnpm setup:voice`. It installs faster-whisper + the `whetstone-whisper` console-script
// wrapper, pre-fetches the model, and writes WHISPER_BINARY / WHISPER_MODEL_PATH / WHISPER_LANGUAGE to
// the root `.env` (which the server dev/start already load). Excluded from the base `pnpm setup`
// (heavy/network); every failure mode returns an actionable { what, remedy }, never a raw crash.

import { fileURLToPath } from "node:url";

import { envPath, parseEnvVars, readEnv, upsertEnvVars } from "../env-file.mjs";
import { installSystemTool } from "../installSystemTool.mjs";
import { error, isOk, missing, ok, withOutputTail } from "../step.mjs";

// Re-exported so this file stays the voice step's public surface; the `.env` line helpers now live in
// the shared env-file owner (#382) but voice's tests and any voice consumer import them from here.
export { parseEnvVars, upsertEnvVars };

const DEFAULT_MODEL = "small";
const WRAPPER_DIR = fileURLToPath(new URL("../whisper-wrapper", import.meta.url));
const SAMPLE_AUDIO = fileURLToPath(new URL("./voice-sample.wav", import.meta.url));

const PYTHON_DOCS = "https://www.python.org/downloads";
const PYTHON_REMEDY =
  "Install Python 3 (https://www.python.org/downloads, or `winget install Python.Python.3` / " +
  "`brew install python`), then re-run `pnpm setup:voice`.";

/**
 * Validate wrapper stdout against the **same strict contract the runtime adapter enforces** —
 * `parseWhisperOutput` in `src/apps/server/src/speech/whisperSpeechInput.ts`: a string `text`, an
 * array `segments`, each segment an object with a `words` array, each word an object with a string
 * `word` and numeric `start`/`end` where `end` is not before `start`. Setup must not report ready
 * for output the server would reject at transcribe time (e.g. `{"text":"","segments":[{}]}`).
 *
 * This mirror is intentionally self-contained (node-builtins only): the step registry imports this
 * file during `pnpm setup` on a fresh clone *before* dependencies exist, so it cannot import the
 * server/contracts packages. Keep it in lockstep with `parseWhisperOutput`; the regression tests in
 * voice.test.mjs pin the malformed-segment/word cases.
 *
 * @param {string} stdout
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateWhisperContract(stdout) {
  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const fail = (reason) => ({ ok: false, reason });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail("output was not valid JSON");
  }
  if (!isRecord(parsed)) {
    return fail("output was not a JSON object");
  }
  if (typeof parsed.text !== "string") {
    return fail('missing string "text"');
  }
  if (!Array.isArray(parsed.segments)) {
    return fail('missing array "segments"');
  }
  for (const segment of parsed.segments) {
    if (!isRecord(segment)) {
      return fail("a segment was not an object");
    }
    if (!Array.isArray(segment.words)) {
      return fail('a segment is missing a "words" array');
    }
    for (const word of segment.words) {
      if (!isRecord(word)) {
        return fail("a word was not an object");
      }
      if (typeof word.word !== "string") {
        return fail('a word is missing a string "word"');
      }
      if (typeof word.start !== "number") {
        return fail('a word is missing a numeric "start"');
      }
      if (typeof word.end !== "number") {
        return fail('a word is missing a numeric "end"');
      }
      if (word.end < word.start) {
        return fail("a word ends before it starts");
      }
    }
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
 * Readiness probe + install spec for the Python 3 system prerequisite, driven through the shared
 * consent-gated `installSystemTool` seam. On win32/darwin it offers a native install after an
 * explicit Y (or `--yes`); everywhere else — and on decline / no package manager — it falls back to
 * the instruct-only `PYTHON_REMEDY`. `check` here is non-mutating (never installs).
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult}
 */
function pythonCheck(ctx) {
  return resolvePython(ctx) === null
    ? missing("Python 3 was not found (required for local Whisper STT).", PYTHON_REMEDY)
    : ok();
}

/** @type {import("../installSystemTool.mjs").InstallSpec} */
const PYTHON_SPEC = {
  name: "Python 3",
  check: pythonCheck,
  remedy: PYTHON_REMEDY,
  docs: PYTHON_DOCS,
  question: "Install Python 3 now? [Y/n]",
  plans: {
    win32: { manager: "winget", args: ["install", "Python.Python.3"] },
    darwin: { manager: "brew", args: ["install", "python"] }
  }
};

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
        "Run `pnpm setup:voice` to install it and wire up Whisper."
      );
    }
    const env = readEnv(ctx);
    if (env.WHISPER_BINARY === undefined || env.WHISPER_MODEL_PATH === undefined) {
      return missing(
        "Whisper is not wired into .env (WHISPER_BINARY / WHISPER_MODEL_PATH).",
        "Run `pnpm setup:voice`."
      );
    }
    if (!ctx.fs.exists(env.WHISPER_BINARY)) {
      return missing(
        `The whetstone-whisper launcher is missing (${env.WHISPER_BINARY}).`,
        "Run `pnpm setup:voice` to reinstall it."
      );
    }
    return ok();
  },
  provision(ctx) {
    // Consent-gated: offer to install Python 3 after an explicit Y (or `--yes`); on decline, no
    // package manager, or a non-interactive run, fall back to the instruct-only remedy unchanged.
    const pythonReady = installSystemTool(ctx, PYTHON_SPEC);
    if (!isOk(pythonReady)) {
      return pythonReady;
    }
    const python = resolvePython(ctx);
    if (python === null) {
      // The package manager reported success but Python is still not on this shell's PATH (common on
      // Windows until a new terminal is opened): instruct the user to re-run in a fresh shell.
      return missing("Python 3 was not found (required for local Whisper STT).", PYTHON_REMEDY);
    }
    const pip = ctx.exec(python, ["-m", "pip", "install", "faster-whisper"]);
    if (pip.code !== 0) {
      return error(
        "`pip install faster-whisper` failed.",
        withOutputTail(
          "Ensure pip is available (`python -m ensurepip --upgrade`) and check your network/proxy, then re-run `pnpm setup:voice`.",
          pip
        )
      );
    }

    const wrapper = ctx.exec(python, ["-m", "pip", "install", WRAPPER_DIR]);
    if (wrapper.code !== 0) {
      return error(
        "Installing the whetstone-whisper wrapper failed.",
        withOutputTail("Re-run `pnpm setup:voice` and inspect the pip error above.", wrapper)
      );
    }

    const located = ctx.exec(python, ["-m", "whetstone_whisper.locate"]);
    const launcher = located.stdout.trim();
    if (located.code !== 0 || launcher.length === 0) {
      return error(
        "The whetstone-whisper launcher could not be located after installation.",
        "Ensure your Python scripts directory is on PATH, then re-run `pnpm setup:voice`."
      );
    }

    const model = ctx.env.WHISPER_MODEL ?? DEFAULT_MODEL;
    const fetched = ctx.exec(python, ["-m", "whetstone_whisper.fetch", model]);
    if (fetched.code !== 0) {
      return error(
        `Downloading the Whisper model "${model}" failed.`,
        withOutputTail(
          "Retry, pick a smaller model (`WHISPER_MODEL=base.en pnpm run setup -- --voice`), or check connectivity.",
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
        "Re-run `pnpm setup:voice`."
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
          "See docs/SPEECH.md and check the model; then re-run `pnpm setup:voice`.",
          result
        )
      );
    }
    const shape = validateWhisperContract(result.stdout);
    if (!shape.ok) {
      return error(
        `The wrapper emitted off-contract output: ${shape.reason}.`,
        withOutputTail("See docs/SPEECH.md and check the model.", result)
      );
    }
    return ok();
  }
};
