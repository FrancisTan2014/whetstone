// Optional setup step (#800): make CPU-local Qwen3-ASR-1.7B the bundled voice default with one command —
// `pnpm setup:voice`. It provisions a Whetstone-owned, isolated Python virtual environment under ignored
// `.data/`, pins the runtime (`qwen-asr`, a CPU PyTorch, the `whetstone-qwen` console-script wrapper) and
// the pinned `Qwen/Qwen3-ASR-1.7B` model snapshot, then writes the provider-neutral `LOCAL_ASR_BINARY` /
// `LOCAL_ASR_MODEL` pair to the root `.env` and removes the legacy `WHISPER_*` entries. It never installs
// into the user's global Python. Diary consumes only the local speech contract (#799), so this step owns
// one reproducible inference runtime and nothing about the model leaks into the app. Excluded from the
// base `pnpm setup` (heavy/network); every failure mode returns an actionable { what, remedy }, never a
// raw crash.

import { fileURLToPath } from "node:url";

import { envPath, parseEnvVars, readEnv, removeEnvVars, upsertEnvVars } from "../env-file.mjs";
import { installSystemTool } from "../installSystemTool.mjs";
import { error, isOk, missing, ok, withOutputTail } from "../step.mjs";

// Re-exported so this file stays the voice step's public surface; the `.env` line helpers now live in
// the shared env-file owner (#382) but voice's tests and any voice consumer import them from here.
export { parseEnvVars, upsertEnvVars };

const GIB = 1024 ** 3;

const QWEN_WRAPPER_DIR = fileURLToPath(new URL("../qwen-wrapper", import.meta.url));
const SAMPLE_AUDIO = fileURLToPath(new URL("./voice-sample.wav", import.meta.url));

// The executable contract version this Whetstone build requires from a local speech launcher. Both the
// bundled `whetstone-qwen` wrapper and any provider-neutral `LOCAL_ASR_BINARY` print it via the cheap
// `--contract-version` probe (no model/audio load); readiness requires an EXACT match. Keep in lockstep
// with `CONTRACT_VERSION` in scripts/setup/qwen-wrapper/whetstone_qwen/cli.py and
// `LOCAL_SPEECH_CONTRACT_VERSION` in src/apps/server/src/speech/localSpeechInput.ts.
const SUPPORTED_SPEECH_CONTRACT_VERSION = "1";

// The bundled provider's pinned identity. The default only moves with MEASURED real-speech fidelity, so
// the model revision is an IMMUTABLE commit (never a mutable tag) and the runtime is fully pinned. Keep
// the revision in lockstep with MODEL_REVISION in qwen-wrapper/whetstone_qwen/cli.py.
const QWEN_MODEL_REPO = "Qwen/Qwen3-ASR-1.7B";
const QWEN_MODEL_REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5";
const QWEN_ASR_VERSION = "0.0.6";
// CPU PyTorch, installed from the CPU wheel index so no CUDA build is ever pulled. This is the one pin
// that must be verified against the reference host; a drift here changes inference numerics, so it feeds
// the runtime version marker below (a change forces an environment repair).
const TORCH_VERSION = "2.5.1";
const TORCH_CPU_INDEX_URL = "https://download.pytorch.org/whl/cpu";

// The managed runtime lives under ignored local data (never the user's global Python). A version marker
// file inside the venv records the exact pin set; setup repairs (recreates) the environment whenever the
// marker is absent or does not match, so a stale/incomplete venv is never trusted. Any pin change below
// changes the marker and forces that repair.
const VOICE_DATA_DIR = ".data/voice";
const VENV_DIR = `${VOICE_DATA_DIR}/qwen-venv`;
const VENV_MARKER = ".whetstone-voice-runtime";
const VOICE_RUNTIME_VERSION = `${QWEN_MODEL_REPO}@${QWEN_MODEL_REVISION}+torch${TORCH_VERSION}+qwen-asr${QWEN_ASR_VERSION}`;

// The resource floor preflighted BEFORE any multi-GiB download/load, matching the wrapper's advertised
// requirements. Insufficient resources fail with the exact requirement and remedy — never a silent
// fallback to a less accurate model.
const REQUIRED_DISK_GIB = 12;
const REQUIRED_MEMORY_GIB = 12;

// Inline Python one-liners run through the VENV interpreter: probe the pinned model snapshot from cache
// only (`local_files_only=True`, exits non-zero when it is not already present at the exact revision),
// and download it at the exact revision otherwise.
const MODEL_PROBE =
  `from huggingface_hub import snapshot_download;` +
  `snapshot_download('${QWEN_MODEL_REPO}',revision='${QWEN_MODEL_REVISION}',local_files_only=True)`;
const MODEL_DOWNLOAD =
  `from huggingface_hub import snapshot_download;` +
  `snapshot_download('${QWEN_MODEL_REPO}',revision='${QWEN_MODEL_REVISION}')`;

const PARTIAL_LOCAL_WHAT =
  "Local speech is partially configured: exactly one of LOCAL_ASR_BINARY / LOCAL_ASR_MODEL is set.";
const PARTIAL_LOCAL_REMEDY =
  "Set both LOCAL_ASR_BINARY (the local speech executable) and LOCAL_ASR_MODEL (its model identifier), " +
  "or unset both and run `pnpm setup:voice` for the bundled Qwen3-ASR provider. See docs/SPEECH.md.";
const LOCAL_MISSING_REMEDY =
  "Point LOCAL_ASR_BINARY at the local speech executable (and LOCAL_ASR_MODEL at its model identifier), " +
  "or unset both and run `pnpm setup:voice` for the bundled Qwen3-ASR provider. See docs/SPEECH.md.";
const NOT_INSTALLED_REMEDY = "Run `pnpm setup:voice` to install the bundled Qwen3-ASR provider.";
const MIXED_CONFIG_HINT =
  "[setup] Local speech uses LOCAL_ASR_BINARY + LOCAL_ASR_MODEL (authoritative); legacy WHISPER_* is " +
  "also set and ignored — remove it to finish the migration.";
const WHISPER_MIGRATION_HINT =
  "[setup] Legacy WHISPER_* is still configured; the bundled default is now Qwen3-ASR. Run " +
  "`pnpm setup:voice` to migrate to LOCAL_ASR_* (see docs/SPEECH.md).";

const PYTHON_DOCS = "https://www.python.org/downloads";
const PYTHON_REMEDY =
  "Install Python 3 (https://www.python.org/downloads, or `winget install Python.Python.3` / " +
  "`brew install python`), then re-run `pnpm setup:voice`.";

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function trimmedOrUndefined(value) {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Mirror of the runtime `readSpeechConfig` resolution (src/apps/server/src/speech/speechConfig.ts),
 * reduced to the discriminated verdict the setup step acts on:
 * - `local`         — the complete provider-neutral pair is authoritative; `legacyAlsoPresent` flags a
 *                     mixed config (leftover WHISPER_* ignored) so the migration stays visible.
 * - `partial-local` — exactly one new key: an explicit configuration error, never a silent fallback.
 * - `whisper`       — no new key, but the complete legacy pair is present (the migration fallback).
 * - `none`          — nothing configured; the runtime falls back to the deterministic fake.
 *
 * Self-contained (node-builtins only): the step registry imports this file during `pnpm setup` on a
 * fresh clone before the server/contracts packages exist, so it cannot import the resolver. Keep the
 * rules in lockstep; voice.test.mjs pins the new-only, partial, legacy, and mixed cases.
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

/** @param {import("../step.mjs").SetupContext} ctx @returns {string} */
function venvDir(ctx) {
  return `${ctx.root}/${VENV_DIR}`;
}

/**
 * The managed venv's Python interpreter and installed `whetstone-qwen` launcher. A venv puts console
 * scripts under `Scripts\*.exe` on Windows and `bin/*` elsewhere; the paths are therefore deterministic,
 * so no locate step is needed to find the launcher after install.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string}
 */
function venvPython(ctx) {
  return ctx.platform === "win32"
    ? `${venvDir(ctx)}/Scripts/python.exe`
    : `${venvDir(ctx)}/bin/python`;
}

/** @param {import("../step.mjs").SetupContext} ctx @returns {string} */
function managedLauncher(ctx) {
  return ctx.platform === "win32"
    ? `${venvDir(ctx)}/Scripts/whetstone-qwen.exe`
    : `${venvDir(ctx)}/bin/whetstone-qwen`;
}

/** @param {import("../step.mjs").SetupContext} ctx @returns {string} */
function markerPath(ctx) {
  return `${venvDir(ctx)}/${VENV_MARKER}`;
}

/**
 * The readiness message + remedy for a configured LOCAL_ASR provider that fails the contract probe.
 * Provider-neutral: it names LOCAL_ASR_BINARY and the exact contract version to emit and offers the
 * bundled fallback — it never assumes the executable is a specific engine.
 *
 * @param {string} reason
 * @returns {{ what: string, remedy: string }}
 */
function incompatibleLocalProvider(reason) {
  return {
    what: `The configured local speech provider (LOCAL_ASR_BINARY) is incompatible: ${reason}.`,
    remedy:
      `The executable must answer \`--contract-version\` with ${SUPPORTED_SPEECH_CONTRACT_VERSION} ` +
      "(see docs/SPEECH.md). Point LOCAL_ASR_BINARY at a compatible provider, or unset LOCAL_ASR_BINARY " +
      "+ LOCAL_ASR_MODEL and run `pnpm setup:voice` for the bundled Qwen3-ASR provider."
  };
}

/**
 * Log the managed provider's descriptor (provider name, pinned revision, resource requirements) from the
 * cheap contract probe, so `pnpm setup:doctor` reports what is installed without loading the model. A
 * custom LOCAL_ASR binary may not carry these extra fields; then nothing is logged (best-effort).
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {unknown} descriptor  The parsed `--contract-version` payload (always a JSON object here).
 * @returns {void}
 */
function logProviderDescriptor(ctx, descriptor) {
  // `probeSpeechContract` only returns a descriptor when the probe output parsed to a JSON object, so
  // `descriptor` is a record here; the fields inside it are still validated before being logged.
  const record = /** @type {Record<string, unknown>} */ (descriptor);
  const provider = record.provider;
  const revision = record.revision;
  if (typeof provider !== "string" || typeof revision !== "string") {
    return;
  }
  const requirements = record.requirements;
  let needs = "";
  if (typeof requirements === "object" && requirements !== null) {
    const req = /** @type {Record<string, unknown>} */ (requirements);
    if (typeof req.diskGiB === "number" && typeof req.memoryGiB === "number") {
      needs = ` (needs ${req.diskGiB} GiB free disk, ${req.memoryGiB} GiB available memory)`;
    }
  }
  ctx.log(`[setup] local speech provider: ${provider} @ ${revision}${needs}`);
}

/**
 * The provider-neutral readiness verdict for the resolved voice config, shared by `check` and any
 * consumer. A complete new pair is **authoritative**: its own executable is probed (not a specific
 * engine) and it needs no global Python prerequisite; a mixed config logs a migration hint while still
 * reporting ready; a partial pair is an explicit configuration error; a legacy-only Whisper config still
 * works via the #799 fallback but is nudged toward the Qwen default; and nothing configured means the
 * bundled provider is not installed yet. Matches the runtime resolution so `pnpm setup:doctor` never
 * disagrees with what boot does.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {ReturnType<typeof resolveVoiceConfig>} config
 * @returns {import("../step.mjs").StepResult}
 */
export function voiceReadiness(ctx, config) {
  if (config.kind === "partial-local") {
    return error(PARTIAL_LOCAL_WHAT, PARTIAL_LOCAL_REMEDY);
  }
  if (config.kind === "none") {
    return missing(
      "The bundled local speech provider (Qwen3-ASR) is not installed.",
      NOT_INSTALLED_REMEDY
    );
  }
  if (config.kind === "whisper") {
    // The legacy pair still transcribes via the #799 whisper fallback, but the bundled default is now
    // Qwen. Probe the configured launcher's contract as usual; when it is ready, report ready and nudge
    // the migration, otherwise point at `pnpm setup:voice` to install the bundled provider.
    if (!ctx.fs.exists(config.binaryPath)) {
      return missing(
        `The configured legacy Whisper launcher is missing (${config.binaryPath}).`,
        NOT_INSTALLED_REMEDY
      );
    }
    const contract = probeSpeechContract(ctx, config.binaryPath);
    if (!contract.ok) {
      const { what } = incompatibleLocalProvider(contract.reason);
      return missing(what, NOT_INSTALLED_REMEDY);
    }
    ctx.log(WHISPER_MIGRATION_HINT);
    return ok();
  }
  // kind === "local"
  if (!ctx.fs.exists(config.binaryPath)) {
    return missing(
      `The configured local speech executable is missing (${config.binaryPath}).`,
      LOCAL_MISSING_REMEDY
    );
  }
  const contract = probeSpeechContract(ctx, config.binaryPath);
  if (!contract.ok) {
    const { what, remedy } = incompatibleLocalProvider(contract.reason);
    return missing(what, remedy);
  }
  logProviderDescriptor(ctx, contract.descriptor);
  if (config.legacyAlsoPresent) {
    ctx.log(MIXED_CONFIG_HINT);
  }
  return ok();
}

/**
 * Validate a local speech launcher's transcription output against the **#799 transcript-first contract**
 * the runtime adapter enforces (`parseLocalSpeechOutput` in src/apps/server/src/speech/localSpeechInput.ts):
 * a JSON object with a string `text`, an array `segments` (empty is valid — this provider emits no word
 * timing), and a `language` that is a string or null. Setup must not report ready for output the server
 * would reject at transcribe time. Self-contained (node-builtins only) for the fresh-clone import
 * constraint; keep in lockstep with the adapter's parser.
 *
 * @param {string} stdout
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateLocalSpeechContract(stdout) {
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
  if (parsed.language !== null && typeof parsed.language !== "string") {
    return fail('"language" must be a string or null');
  }
  return { ok: true };
}

/**
 * Execute a local speech launcher's cheap machine-readable contract probe (`--contract-version`) and
 * require the EXACT supported contract version. Provider-neutral: both the bundled `whetstone-qwen`
 * wrapper and any `LOCAL_ASR_BINARY` share this probe. File presence is not readiness (#780): a nonzero
 * exit, non-JSON/malformed output, or a version mismatch is **incompatible — never ready**. On success the
 * parsed descriptor is returned alongside `ok` so doctor can report the provider/revision/requirements
 * without a second spawn. Only the structured reason is surfaced on failure; the raw stderr/traceback is
 * intentionally dropped so doctor never shows a stack trace.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {string} binaryPath  The configured launcher (LOCAL_ASR_BINARY or a legacy WHISPER_BINARY).
 * @returns {{ ok: true, descriptor: unknown } | { ok: false, reason: string }}
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
  return { ok: true, descriptor: parsed };
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
 * Non-mutating readiness probe for the Python 3 system prerequisite (needed to build the isolated venv).
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult}
 */
function pythonCheck(ctx) {
  return resolvePython(ctx) === null
    ? missing("Python 3 was not found (required to build the local Qwen3-ASR runtime).", PYTHON_REMEDY)
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

/**
 * Preflight the resource floor before any multi-GiB download/load. Returns an actionable error naming the
 * exact requirement + remedy when disk or memory is short, or null when both are sufficient. The volume
 * probed is the one that will hold the venv (`.data/voice` once it exists, else the repo root, which is
 * the same volume). Never silently falls back to a less accurate model.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {import("../step.mjs").StepResult | null}
 */
function checkResources(ctx) {
  const dataDir = `${ctx.root}/${VOICE_DATA_DIR}`;
  const probePath = ctx.fs.exists(dataDir) ? dataDir : ctx.root;
  const { diskFreeBytes, memoryAvailableBytes } = ctx.resources(probePath);
  const gib = (bytes) => (bytes / GIB).toFixed(1);
  if (diskFreeBytes < REQUIRED_DISK_GIB * GIB) {
    return error(
      `Not enough free disk to install the Qwen3-ASR runtime: ${REQUIRED_DISK_GIB} GiB required, ` +
        `${gib(diskFreeBytes)} GiB free.`,
      `Free at least ${REQUIRED_DISK_GIB} GiB on the volume holding this repository, then re-run ` +
        "`pnpm setup:voice`."
    );
  }
  if (memoryAvailableBytes < REQUIRED_MEMORY_GIB * GIB) {
    return error(
      `Not enough available memory to run the Qwen3-ASR model: ${REQUIRED_MEMORY_GIB} GiB required, ` +
        `${gib(memoryAvailableBytes)} GiB available.`,
      `Close other applications to free at least ${REQUIRED_MEMORY_GIB} GiB of memory, then re-run ` +
        "`pnpm setup:voice`."
    );
  }
  return null;
}

/**
 * Ensure the managed venv exists with the exact pinned runtime, repairing it when the version marker is
 * absent or stale. When (re)building it: create the venv with `--clear` (wiping any incomplete prior
 * attempt), install the CPU PyTorch pin from the CPU wheel index, install the `whetstone-qwen` wrapper
 * (which pulls `qwen-asr`/`av`/`numpy`), fetch the pinned model snapshot if not already cached, then write
 * the marker. A healthy, matching venv is a no-op (idempotent). Returns an actionable error on any failed
 * step, or ok().
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {string} python  A resolved global Python used only to bootstrap the venv.
 * @returns {import("../step.mjs").StepResult}
 */
function ensureRuntime(ctx, python) {
  const venvPy = venvPython(ctx);
  const marker = markerPath(ctx);
  const healthy =
    ctx.fs.exists(venvPy) &&
    ctx.fs.exists(marker) &&
    ctx.fs.readText(marker).trim() === VOICE_RUNTIME_VERSION;
  if (healthy) {
    return ok();
  }

  const created = ctx.exec(python, ["-m", "venv", "--clear", venvDir(ctx)]);
  if (created.code !== 0) {
    return error(
      "Creating the isolated Qwen3-ASR virtual environment failed.",
      withOutputTail(
        "Ensure Python 3 includes the `venv` module (`python -m ensurepip --upgrade`), then re-run `pnpm setup:voice`.",
        created
      )
    );
  }

  const torch = ctx.exec(venvPy, [
    "-m",
    "pip",
    "install",
    `torch==${TORCH_VERSION}`,
    "--index-url",
    TORCH_CPU_INDEX_URL
  ]);
  if (torch.code !== 0) {
    return error(
      `Installing the pinned CPU PyTorch (torch==${TORCH_VERSION}) into the voice runtime failed.`,
      withOutputTail("Check your network/proxy, then re-run `pnpm setup:voice`.", torch)
    );
  }

  const wrapper = ctx.exec(venvPy, ["-m", "pip", "install", QWEN_WRAPPER_DIR]);
  if (wrapper.code !== 0) {
    return error(
      `Installing the whetstone-qwen provider (qwen-asr==${QWEN_ASR_VERSION}) into the voice runtime failed.`,
      withOutputTail("Check your network/proxy, then re-run `pnpm setup:voice`.", wrapper)
    );
  }

  if (ctx.exec(venvPy, ["-c", MODEL_PROBE]).code !== 0) {
    const download = ctx.exec(venvPy, ["-c", MODEL_DOWNLOAD]);
    if (download.code !== 0) {
      return error(
        `Downloading the pinned model snapshot (${QWEN_MODEL_REPO}@${QWEN_MODEL_REVISION}) failed.`,
        withOutputTail("Check connectivity and free disk, then re-run `pnpm setup:voice`.", download)
      );
    }
  }

  ctx.fs.writeText(marker, `${VOICE_RUNTIME_VERSION}\n`);
  return ok();
}

/** @type {import("../step.mjs").Step} */
export const voiceStep = {
  id: "voice",
  title: "Voice input (local Qwen3-ASR STT)",
  optional: true,
  capability: "voice",
  check(ctx) {
    return voiceReadiness(ctx, resolveVoiceConfig(readEnv(ctx)));
  },
  provision(ctx) {
    const config = resolveVoiceConfig(readEnv(ctx));
    if (config.kind === "partial-local") {
      return error(PARTIAL_LOCAL_WHAT, PARTIAL_LOCAL_REMEDY);
    }
    // A CUSTOM provider-neutral LOCAL_ASR provider (a binary other than the managed venv launcher) owns
    // readiness: this bundled installer must never clobber the operator's chosen provider. Only the
    // bundled managed launcher (or an unconfigured/legacy state we migrate) is (re)provisioned here.
    if (config.kind === "local" && config.binaryPath !== managedLauncher(ctx)) {
      return error(
        `A custom local speech provider is configured via LOCAL_ASR_BINARY (${config.binaryPath}); ` +
          "`pnpm setup:voice` manages only the bundled Qwen3-ASR runtime and will not modify it.",
        "Unset LOCAL_ASR_BINARY + LOCAL_ASR_MODEL to let `pnpm setup:voice` install the bundled " +
          "provider, or keep your provider and ensure it answers `--contract-version`. See docs/SPEECH.md."
      );
    }

    // Consent-gated: offer to install Python 3 after an explicit Y (or `--yes`); on decline, no package
    // manager, or a non-interactive run, fall back to the instruct-only remedy unchanged.
    const pythonReady = installSystemTool(ctx, PYTHON_SPEC);
    if (!isOk(pythonReady)) {
      return pythonReady;
    }
    // pythonCheck just passed, so a Python interpreter resolves here (its "installed but off PATH" case
    // already returns missing). Capture which command — `python` vs `python3` — to bootstrap the venv.
    const python = resolvePython(ctx);

    // Preflight disk + memory BEFORE the heavy download/load, so an under-provisioned host fails fast with
    // the exact requirement rather than part-way through a multi-GiB install.
    const resourceGap = checkResources(ctx);
    if (resourceGap !== null) {
      return resourceGap;
    }

    const runtime = ensureRuntime(ctx, python);
    if (!isOk(runtime)) {
      return runtime;
    }

    // Write the provider-neutral pair and retire the legacy WHISPER_* entries, so the runtime resolves the
    // bundled Qwen provider and no stale key is left to be honoured or reported as a mixed config.
    const path = envPath(ctx);
    const content = ctx.fs.exists(path) ? ctx.fs.readText(path) : "";
    const withLocal = upsertEnvVars(content, {
      LOCAL_ASR_BINARY: managedLauncher(ctx),
      LOCAL_ASR_MODEL: QWEN_MODEL_REPO
    });
    ctx.fs.writeText(path, removeEnvVars(withLocal, ["WHISPER_BINARY", "WHISPER_MODEL_PATH"]));
    return ok();
  },
  verify(ctx) {
    const env = readEnv(ctx);
    if (env.LOCAL_ASR_BINARY === undefined || env.LOCAL_ASR_MODEL === undefined) {
      return error(
        "Local speech is not wired into .env after provisioning (LOCAL_ASR_BINARY + LOCAL_ASR_MODEL).",
        "Re-run `pnpm setup:voice`."
      );
    }
    // Post-provision verification requires BOTH the cheap contract probe and one real sample inference
    // (#780/#800): the probe proves the freshly installed launcher speaks the exact contract, and the
    // sample proves CPU inference reaches the model and produces on-contract output before a saved capture
    // is retried.
    const contract = probeSpeechContract(ctx, env.LOCAL_ASR_BINARY);
    if (!contract.ok) {
      const { what, remedy } = incompatibleLocalProvider(contract.reason);
      return error(what, remedy);
    }
    logProviderDescriptor(ctx, contract.descriptor);
    const result = ctx.exec(env.LOCAL_ASR_BINARY, [
      "--model",
      env.LOCAL_ASR_MODEL,
      "--output",
      "json",
      SAMPLE_AUDIO
    ]);
    if (result.code !== 0) {
      return error(
        "The bundled Qwen3-ASR provider failed on the sample audio.",
        withOutputTail("See docs/SPEECH.md and check the runtime; then re-run `pnpm setup:voice`.", result)
      );
    }
    const shape = validateLocalSpeechContract(result.stdout);
    if (!shape.ok) {
      return error(
        `The provider emitted off-contract output: ${shape.reason}.`,
        withOutputTail("See docs/SPEECH.md and check the runtime.", result)
      );
    }
    return ok();
  }
};
