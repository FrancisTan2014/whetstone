// Optional setup step (first consumer of the #346 framework): enable local Whisper STT with one
// command — `pnpm setup:voice`. It installs faster-whisper + the `whetstone-whisper` console-script
// wrapper, pre-fetches the model, and writes WHISPER_BINARY / WHISPER_MODEL_PATH to the root `.env`
// (which the server dev/start already load). Whisper always auto-detects the spoken language, so there
// is no WHISPER_LANGUAGE (#647). Excluded from the base `pnpm setup` (heavy/network); every failure mode
// returns an actionable { what, remedy }, never a raw crash.

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

// The executable contract version this Whetstone build requires from a local speech launcher. Both the
// bundled `whetstone-whisper` wrapper and any provider-neutral `LOCAL_ASR_BINARY` print it via the cheap
// `--contract-version` probe (no model/audio load); readiness requires an EXACT match. This is
// deliberately separate from the wrapper's pip package version — a pre-#647 wrapper that forwards
// `--language auto` literally can share a package version with the current one, so only an
// executable-contract probe (not file presence) can tell them apart (#780). Keep this in lockstep with
// `CONTRACT_VERSION` in scripts/setup/whisper-wrapper/whetstone_whisper/cli.py and
// `LOCAL_SPEECH_CONTRACT_VERSION` in src/apps/server/src/speech/localSpeechInput.ts.
const SUPPORTED_SPEECH_CONTRACT_VERSION = "1";

// The provider-neutral local ASR pair (#799). doctor/setup must resolve it the SAME way the runtime does
// (`readSpeechConfig` in src/apps/server/src/speech/speechConfig.ts) so the doctor verdict never
// disagrees with what the server does at boot. This is a self-contained mirror (node-builtins only): the
// step registry imports this file during `pnpm setup` on a fresh clone *before* the server/contracts
// packages exist, so it cannot import the resolver. Keep the rules — new pair authoritative, partial =
// error, legacy honoured only when no new key is present, mixed reported — in lockstep; voice.test.mjs
// pins the new-only, partial, legacy, and mixed cases.
const PARTIAL_LOCAL_WHAT =
  "Local speech is partially configured: exactly one of LOCAL_ASR_BINARY / LOCAL_ASR_MODEL is set.";
const PARTIAL_LOCAL_REMEDY =
  "Set both LOCAL_ASR_BINARY (the local speech executable) and LOCAL_ASR_MODEL (its model identifier), " +
  "or unset both to fall back. See docs/SPEECH.md, or run: pnpm setup:voice";
const LOCAL_MISSING_REMEDY =
  "Point LOCAL_ASR_BINARY at the local speech executable (and LOCAL_ASR_MODEL at its model identifier), " +
  "or unset both and run `pnpm setup:voice` for the bundled Whisper provider. See docs/SPEECH.md.";
const LOCAL_PROVISION_REMEDY =
  "Ensure LOCAL_ASR_BINARY points at a ready provider that answers `--contract-version` with " +
  `${SUPPORTED_SPEECH_CONTRACT_VERSION} (see docs/SPEECH.md), or unset LOCAL_ASR_BINARY + ` +
  "LOCAL_ASR_MODEL to install the bundled Whisper provider.";
const MIXED_CONFIG_HINT =
  "[setup] Local speech uses LOCAL_ASR_BINARY + LOCAL_ASR_MODEL (authoritative); legacy WHISPER_* is " +
  "also set and ignored — remove it to finish the migration.";

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function trimmedOrUndefined(value) {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Mirror of the runtime `readSpeechConfig` resolution (see the block comment above), reduced to the
 * discriminated verdict the setup step acts on:
 * - `local`         — the complete provider-neutral pair is authoritative; `legacyAlsoPresent` flags a
 *                     mixed config (leftover WHISPER_* ignored) so the migration stays visible.
 * - `partial-local` — exactly one new key: an explicit configuration error, never a silent fallback.
 * - `whisper`       — no new key, but the complete legacy pair is present (the migration fallback).
 * - `none`          — nothing configured; the runtime falls back to the deterministic fake.
 *
 * @param {Record<string, string>} env  The parsed `.env` map (from `readEnv`).
 * @returns {{ kind: "local", binaryPath: string, modelIdentifier: string, legacyAlsoPresent: boolean }
 *   | { kind: "partial-local" }
 *   | { kind: "whisper", binaryPath: string, modelPath: string }
 *   | { kind: "none" }}
 */
export function resolveVoiceConfig(env) {
  const localBinary = trimmedOrUndefined(env.LOCAL_ASR_BINARY);
  const localModel = trimmedOrUndefined(env.LOCAL_ASR_MODEL);
  const whisperBinary = trimmedOrUndefined(env.WHISPER_BINARY);
  const whisperModel = trimmedOrUndefined(env.WHISPER_MODEL_PATH);

  if (localBinary !== undefined && localModel !== undefined) {
    return {
      kind: "local",
      binaryPath: localBinary,
      modelIdentifier: localModel,
      legacyAlsoPresent: whisperBinary !== undefined || whisperModel !== undefined
    };
  }
  if (localBinary !== undefined || localModel !== undefined) {
    return { kind: "partial-local" };
  }
  if (whisperBinary !== undefined && whisperModel !== undefined) {
    return { kind: "whisper", binaryPath: whisperBinary, modelPath: whisperModel };
  }
  return { kind: "none" };
}

// The readiness message + remedy for a configured LOCAL_ASR provider that fails the contract probe.
// Provider-neutral: it names LOCAL_ASR_BINARY and the exact contract version to emit and offers the
// bundled fallback — it never assumes the executable is Whisper or tells the operator to reinstall a
// wrapper it does not own.
function incompatibleLocalProvider(reason) {
  return {
    what: `The configured local speech provider (LOCAL_ASR_BINARY) is incompatible: ${reason}.`,
    remedy:
      `The executable must answer \`--contract-version\` with ${SUPPORTED_SPEECH_CONTRACT_VERSION} ` +
      "(see docs/SPEECH.md). Point LOCAL_ASR_BINARY at a compatible provider, or unset LOCAL_ASR_BINARY " +
      "+ LOCAL_ASR_MODEL and run `pnpm setup:voice` for the bundled Whisper provider."
  };
}

/**
 * The provider-neutral readiness verdict for the LOCAL_ASR pair, or `null` when the legacy/bundled
 * Whisper path owns readiness (kinds `whisper`/`none`). A complete new pair is **authoritative**: its own
 * executable is probed (not Whisper's) and it needs no Python/faster-whisper prerequisite; a mixed config
 * logs a migration hint while still reporting ready; a partial pair is an explicit configuration error.
 * This matches the runtime resolution so `pnpm setup:doctor` never disagrees with what boot does.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {ReturnType<typeof resolveVoiceConfig>} config
 * @returns {import("../step.mjs").StepResult | null}
 */
function localProviderReadiness(ctx, config) {
  if (config.kind === "partial-local") {
    return error(PARTIAL_LOCAL_WHAT, PARTIAL_LOCAL_REMEDY);
  }
  if (config.kind !== "local") {
    return null;
  }
  if (!ctx.fs.exists(config.binaryPath)) {
    return missing(
      `The configured local speech executable is missing (${config.binaryPath}).`,
      LOCAL_MISSING_REMEDY
    );
  }
  // File presence is not readiness (#780): probe the configured executable's own contract, exactly like
  // the legacy Whisper launcher, and require the supported version before trusting it to transcribe.
  const contract = probeSpeechContract(ctx, config.binaryPath);
  if (!contract.ok) {
    const { what, remedy } = incompatibleLocalProvider(contract.reason);
    return missing(what, remedy);
  }
  if (config.legacyAlsoPresent) {
    // The new pair wins; the leftover WHISPER_* is ignored. Surface it so the migration stays visible,
    // matching the boot health report's mixed-config hint (speechHealth.ts).
    ctx.log(MIXED_CONFIG_HINT);
  }
  return ok();
}

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
 * Execute a local speech launcher's cheap machine-readable contract probe (`--contract-version`) and
 * require the EXACT supported contract version. Provider-neutral: both the bundled `whetstone-whisper`
 * wrapper and any `LOCAL_ASR_BINARY` share this probe. This is what turns "the launcher file exists" into
 * "the launcher proves the contract Whetstone will invoke" (#780): a wrapper installed before the
 * `--language auto` -> detection fix predates the probe and either lacks the flag (nonzero exit) or
 * reports a different version, and a nonzero exit, non-JSON/malformed output, or a version mismatch is
 * treated as **incompatible — never ready**. Only the structured reason is returned; the raw
 * stderr/traceback is intentionally dropped so doctor never surfaces a stack trace.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {string} binaryPath  The configured launcher (WHISPER_BINARY or LOCAL_ASR_BINARY).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function probeSpeechContract(ctx, binaryPath) {
  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const result = ctx.exec(binaryPath, ["--contract-version"]);
  if (result.code !== 0) {
    return {
      ok: false,
      reason: "it does not answer the --contract-version readiness probe (nonzero exit)"
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: "its --contract-version probe did not emit valid JSON" };
  }
  const version = isRecord(parsed) ? parsed.contractVersion : undefined;
  if (typeof version !== "string") {
    return { ok: false, reason: 'its probe output is missing a string "contractVersion"' };
  }
  if (version !== SUPPORTED_SPEECH_CONTRACT_VERSION) {
    return {
      ok: false,
      reason: `it reports contract version ${version}, but this Whetstone requires ${SUPPORTED_SPEECH_CONTRACT_VERSION}`
    };
  }
  return { ok: true };
}

// The shared readiness message + remedy for an incompatible/stale wrapper: doctor names it and points at
// `pnpm setup:voice` (which repairs the bundled wrapper without redownloading the speech stack), and a
// custom WHISPER_BINARY is told the exact contract version to emit rather than being silently trusted.
function incompatibleWrapper(reason) {
  return {
    what: `The installed whetstone-whisper wrapper is incompatible: ${reason}. A wrapper installed before the language fix forwards "--language auto" to Whisper literally, which fails transcription.`,
    remedy:
      "Run `pnpm setup:voice` to repair the bundled wrapper (it upgrades the wrapper in place without " +
      `redownloading the speech model). A custom WHISPER_BINARY must emit \`--contract-version\` as ${SUPPORTED_SPEECH_CONTRACT_VERSION} — see docs/SPEECH.md.`
  };
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
    // The provider-neutral local ASR pair is authoritative and provider-agnostic — resolve config first
    // and, when a LOCAL_ASR provider is configured, probe ITS contract (no Python/faster-whisper
    // prerequisite; a mixed config is flagged; a partial pair is a configuration error). Only fall
    // through to the legacy bundled-Whisper readiness when no new key is present, so a complete
    // LOCAL_ASR_* is never misreported as "Whisper is not wired".
    const localReady = localProviderReadiness(ctx, resolveVoiceConfig(readEnv(ctx)));
    if (localReady !== null) {
      return localReady;
    }
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
        "Local speech is not wired into .env (LOCAL_ASR_BINARY + LOCAL_ASR_MODEL, or legacy WHISPER_BINARY / WHISPER_MODEL_PATH).",
        "Run `pnpm setup:voice`."
      );
    }
    if (!ctx.fs.exists(env.WHISPER_BINARY)) {
      return missing(
        `The whetstone-whisper launcher is missing (${env.WHISPER_BINARY}).`,
        "Run `pnpm setup:voice` to reinstall it."
      );
    }
    // File presence is not readiness: run the cheap contract probe through the launcher and require the
    // exact supported contract version, so a stale pre-#647 wrapper is reported incompatible (never
    // ready) and `pnpm setup:voice` repairs it instead of skipping provisioning (#780).
    const contract = probeSpeechContract(ctx, env.WHISPER_BINARY);
    if (!contract.ok) {
      const { what, remedy } = incompatibleWrapper(contract.reason);
      return missing(what, remedy);
    }
    return ok();
  },
  provision(ctx) {
    // A configured (or half-configured) provider-neutral LOCAL_ASR provider owns readiness: this bundled
    // installer only provisions the legacy Whisper fallback and must never clobber the operator's chosen
    // provider or leave a partial pair (which the runtime treats as a hard boot error). Report the local
    // verdict instead of installing a different engine over it.
    const config = resolveVoiceConfig(readEnv(ctx));
    if (config.kind === "partial-local") {
      return error(PARTIAL_LOCAL_WHAT, PARTIAL_LOCAL_REMEDY);
    }
    if (config.kind === "local") {
      return error(
        `A local speech provider is configured via LOCAL_ASR_BINARY (${config.binaryPath}); \`pnpm setup:voice\` provisions only the bundled Whisper fallback and will not modify it.`,
        LOCAL_PROVISION_REMEDY
      );
    }
    // Consent-gated: offer to install Python 3 after an explicit Y (or `--yes`); on decline, no
    // package manager, or a non-interactive run, fall back to the instruct-only remedy unchanged.
    const pythonReady = installSystemTool(ctx, PYTHON_SPEC);
    if (!isOk(pythonReady)) {
      return pythonReady;
    }
    // installSystemTool's authoritative `check` (pythonCheck) just passed, so a Python interpreter is
    // guaranteed to resolve here (its "installed but still off PATH" case already returns `missing`).
    // Capture which command — `python` vs `python3` — for the pip invocations below.
    const python = resolvePython(ctx);
    // Only install faster-whisper when its own probe fails: on a stale-wrapper repair the speech stack is
    // already healthy, so re-running `pip install faster-whisper` (and any model redownload) is wasted
    // work — the wrapper is the only thing that needs replacing (#780).
    if (ctx.exec(python, ["-c", "import faster_whisper"]).code !== 0) {
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
    }

    // Always (re)install the bundled wrapper, even when an older installed package shares its version:
    // `--force-reinstall` replaces a same-version stale wrapper (the #780 repair), and `--no-deps` keeps
    // this from reinstalling the already-healthy faster-whisper.
    const wrapper = ctx.exec(python, [
      "-m",
      "pip",
      "install",
      "--upgrade",
      "--force-reinstall",
      "--no-deps",
      WRAPPER_DIR
    ]);
    if (wrapper.code !== 0) {
      return error(
        "Installing the whetstone-whisper wrapper failed.",
        withOutputTail("Re-run `pnpm setup:voice` and inspect the pip error above.", wrapper)
      );
    }

    const located = ctx.exec(python, ["-m", "whetstone_whisper.locate"]);
    const launcher = located.stdout.trim();
    if (located.code !== 0 || launcher.length === 0) {
      // locate.py reports the interpreter's per-user Scripts dir on stderr when it cannot resolve
      // the launcher. Microsoft Store Python installs the console script there but never adds it to
      // PATH (#424), so name that exact directory instead of a generic "put it on PATH".
      const userScriptsDir = located.stderr.trim();
      const remedy =
        userScriptsDir.length > 0
          ? `Microsoft Store Python installed it into "${userScriptsDir}" but does not add that to PATH — ` +
            `add that directory to PATH, or install Python 3 from ${PYTHON_DOCS} with "Add to PATH", ` +
            "then re-run `pnpm setup:voice`."
          : `Install Python 3 from ${PYTHON_DOCS} with "Add to PATH" (so pip's console scripts are ` +
            "resolvable), then re-run `pnpm setup:voice`.";
      return error(
        "The whetstone-whisper launcher could not be located after installation.",
        remedy
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
        WHISPER_MODEL_PATH: model
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
    // Post-provision verification requires BOTH the cheap contract probe and the sample-audio inference
    // (#780): the probe proves the freshly installed launcher speaks the exact contract, and the sample
    // proves `--language auto` reaches the model and produces on-contract output before a saved capture
    // is retried.
    const contract = probeSpeechContract(ctx, env.WHISPER_BINARY);
    if (!contract.ok) {
      const { what, remedy } = incompatibleWrapper(contract.reason);
      return error(what, remedy);
    }
    const result = ctx.exec(env.WHISPER_BINARY, [
      "--model",
      env.WHISPER_MODEL_PATH,
      "--language",
      "auto",
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
