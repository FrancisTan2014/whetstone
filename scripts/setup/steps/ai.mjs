// Optional setup step (#602): provision the local models the optional AI utilities use, with one
// command — `pnpm setup:ai`. The two surviving utilities are the diary "tidy" pass (`DIARY_TIDY_MODEL`)
// and the Reader "AI 解释" contextual gloss (`EXPLAIN_MODEL`); neither depends on the retiring coach.
// This step installs Ollama itself (consent-gated via #383's `installSystemTool`, never silently),
// pulls those two local models, wires the non-secret model names into the root `.env`, and verifies
// each model actually answers through the daemon. It is NOT part of the deterministic base `pnpm
// setup` (heavy/network) — an AI model never ships in the base install (#602). Every failure mode
// returns an actionable { what, remedy }, never a raw crash. No secrets are ever written here, and no
// diary/Reader content is sent to a cloud provider — these utilities are local-only.

import { envPath, readEnv, upsertEnvVars } from "../env-file.mjs";
import { installSystemTool } from "../installSystemTool.mjs";
import { error, isOk, missing, ok, withOutputTail } from "../step.mjs";

// The diary "tidy" model (readDiaryTidyConfig / DIARY_TIDY_MODEL). Mirrors the server's decoupled
// default — llama3.1:8b, the English-best small model — with no coach coupling.
const DEFAULT_DIARY_TIDY_MODEL = "llama3.1:8b";
// The 文言-strong model behind the lookup "AI 解释" aid (readExplainConfig / EXPLAIN_MODEL).
const DEFAULT_EXPLAIN_MODEL = "qwen2.5";

const OLLAMA_DOCS = "https://ollama.com/download";
const OLLAMA_REMEDY =
  "Install Ollama (https://ollama.com/download, or `winget install Ollama.Ollama` / " +
  "`brew install ollama` / `curl -fsSL https://ollama.com/install.sh | sh`), then re-run " +
  "`pnpm setup:ai`.";

/**
 * The runtime-effective diary "tidy" model. Precedence mirrors what the server serves at boot (see
 * readDiaryTidyConfig / DIARY_TIDY_MODEL): a process-env `DIARY_TIDY_MODEL` override wins (dotenv does
 * not overwrite an already-set var), then the value persisted in `.env`, then the default. check/verify
 * pull and probe THIS exact model, and `provision` persists it to `.env`, so a `DIARY_TIDY_MODEL=<x>
 * pnpm setup:ai` override survives into `pnpm dev` instead of the server serving the default.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string}
 */
function resolveDiaryTidyModel(ctx) {
  return ctx.env.DIARY_TIDY_MODEL ?? readEnv(ctx).DIARY_TIDY_MODEL ?? DEFAULT_DIARY_TIDY_MODEL;
}

/**
 * The runtime-effective local "AI 解释" model. Precedence mirrors what the server actually serves at
 * boot: a process-env `EXPLAIN_MODEL` override wins (dotenv does not overwrite an already-set var),
 * then the value persisted in `.env`, then the default. check/verify pull and probe THIS exact model,
 * so setup never reports ready for a model the server would not use.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string}
 */
function resolveExplainModel(ctx) {
  return ctx.env.EXPLAIN_MODEL ?? readEnv(ctx).EXPLAIN_MODEL ?? DEFAULT_EXPLAIN_MODEL;
}

/**
 * Validate that `.env` names the exact local models the runtime consumes for the optional AI
 * utilities: `DIARY_TIDY_MODEL` (the diary "tidy" model) and `EXPLAIN_MODEL` (the "AI 解释" model),
 * both pulled/verified. No coach tiers are pinned here — the utilities are independent of the coach.
 * Returns the first gap via `fail`, or null when both are wired.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {string} diaryTidyModel  The runtime-effective diary tidy model (see resolveDiaryTidyModel).
 * @param {string} explainModel  The runtime-effective explain model (see resolveExplainModel).
 * @param {(what: string) => import("../step.mjs").StepResult} fail
 * @returns {import("../step.mjs").StepResult | null}
 */
function checkEnvWiring(ctx, diaryTidyModel, explainModel, fail) {
  const env = readEnv(ctx);
  if (env.DIARY_TIDY_MODEL !== diaryTidyModel) {
    return fail(
      `.env does not wire DIARY_TIDY_MODEL=${diaryTidyModel} — the local model the diary "tidy" pass will use.`
    );
  }
  if (env.EXPLAIN_MODEL !== explainModel) {
    return fail(
      `.env does not wire EXPLAIN_MODEL=${explainModel} — the local "AI 解释" model the Reader will use.`
    );
  }
  return null;
}

/**
 * The model NAMEs from `ollama list` output — the first column of each row, header row skipped.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseOllamaModelNames(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name.toLowerCase() !== "name");
}

/**
 * Is `model` among the pulled models in `ollama list` output? Matches a full NAME exactly; a request
 * without an explicit `:tag` also matches the `:latest` tag Ollama assigns — so `qwen2.5` matches a
 * listed `qwen2.5:latest` but NOT `qwen2.5-coder:latest` (the loose `stdout.includes(model)` bug).
 *
 * @param {string} stdout  `ollama list` output.
 * @param {string} model
 * @returns {boolean}
 */
export function isModelPulled(stdout, model) {
  const withLatest = model.includes(":") ? model : `${model}:latest`;
  return parseOllamaModelNames(stdout).some((name) => name === model || name === withLatest);
}

/**
 * Is the `ollama` CLI on PATH? (its `--version` exits 0 when present).
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {boolean}
 */
function ollamaPresent(ctx) {
  return ctx.exec("ollama", ["--version"]).code === 0;
}

/**
 * Readiness probe + install spec for the Ollama system prerequisite, driven through the shared
 * consent-gated `installSystemTool` seam: winget on win32, brew on darwin, the official install
 * script on linux, and everywhere else — or on decline / no package manager — the instruct-only
 * `OLLAMA_REMEDY`. `check` here is non-mutating (never installs).
 *
 * @type {import("../installSystemTool.mjs").InstallSpec}
 */
const OLLAMA_SPEC = {
  name: "Ollama",
  check: (ctx) =>
    ollamaPresent(ctx)
      ? ok()
      : missing("Ollama was not found (required for the optional AI utilities).", OLLAMA_REMEDY),
  remedy: OLLAMA_REMEDY,
  docs: OLLAMA_DOCS,
  question: "Install Ollama now? [Y/n]",
  plans: {
    win32: { manager: "winget", args: ["install", "Ollama.Ollama"] },
    darwin: { manager: "brew", args: ["install", "ollama"] },
    // The official one-liner; `detect` probes for curl (its presence, not the manager's) so a host
    // without curl falls back to the manual remedy instead of a failed pipe.
    linux: {
      manager: "sh",
      args: ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
      detect: ["-c", "command -v curl"]
    }
  }
};

/**
 * Shape-check a local model's answer the way the runtime consumes it: `createDiaryTidy` /
 * `createLlmExplainer` treat an empty response as "nothing to show" (diary tidy then keeps the raw
 * transcript; the explanation aid returns null). Setup must not report ready for a model the server
 * would get an empty answer from, so a blank/whitespace answer is off-contract.
 *
 * @param {string} stdout
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateOllamaAnswer(stdout) {
  return stdout.trim().length === 0
    ? { ok: false, reason: "the model returned an empty response" }
    : { ok: true };
}

/** @type {import("../step.mjs").Step} */
export const aiStep = {
  id: "ai",
  title: "Optional AI utilities (local Ollama models)",
  optional: true,
  capability: "ai",
  check(ctx) {
    if (!ollamaPresent(ctx)) {
      return missing(
        "Ollama was not found (required for the optional AI utilities).",
        OLLAMA_REMEDY
      );
    }
    const listed = ctx.exec("ollama", ["list"]);
    const pulled = (model) => listed.code === 0 && isModelPulled(listed.stdout, model);
    const diaryTidyModel = resolveDiaryTidyModel(ctx);
    if (!pulled(diaryTidyModel)) {
      return missing(
        `The diary "tidy" model "${diaryTidyModel}" is not pulled.`,
        `Run \`ollama pull ${diaryTidyModel}\` (or \`pnpm setup:ai\`).`
      );
    }
    const explainModel = resolveExplainModel(ctx);
    if (!pulled(explainModel)) {
      return missing(
        `The "AI 解释" model "${explainModel}" is not pulled.`,
        `Run \`ollama pull ${explainModel}\` (or \`pnpm setup:ai\`).`
      );
    }
    return (
      checkEnvWiring(ctx, diaryTidyModel, explainModel, (what) =>
        missing(what, "Run `pnpm setup:ai`.")
      ) ?? ok()
    );
  },
  provision(ctx) {
    // Consent-gated: offer to install Ollama after an explicit Y (or `--yes`); on decline, no package
    // manager, or a non-interactive run, fall back to the instruct-only remedy unchanged.
    const ollamaReady = installSystemTool(ctx, OLLAMA_SPEC);
    if (!isOk(ollamaReady)) {
      return ollamaReady;
    }

    const diaryTidyModel = resolveDiaryTidyModel(ctx);
    const explainModel = resolveExplainModel(ctx);
    for (const model of [diaryTidyModel, explainModel]) {
      const fetched = ctx.exec("ollama", ["pull", model]);
      if (fetched.code !== 0) {
        return error(
          `Pulling the Ollama model "${model}" failed.`,
          withOutputTail(
            "Ensure the Ollama daemon is running (`ollama serve`) and check your network, then re-run `pnpm setup:ai`.",
            fetched
          )
        );
      }
    }

    const path = envPath(ctx);
    const content = ctx.fs.exists(path) ? ctx.fs.readText(path) : "";
    // Non-secret env only: name the local diary-tidy + explain models the runtime reads (so a
    // `DIARY_TIDY_MODEL` / `EXPLAIN_MODEL` override survives into `pnpm dev`). NEVER write any key or
    // coach tier — these utilities are local-only and independent of the coach.
    ctx.fs.writeText(
      path,
      upsertEnvVars(content, {
        DIARY_TIDY_MODEL: diaryTidyModel,
        EXPLAIN_MODEL: explainModel
      })
    );
    return ok();
  },
  verify(ctx) {
    const diaryTidyModel = resolveDiaryTidyModel(ctx);
    const explainModel = resolveExplainModel(ctx);
    const wiringGap = checkEnvWiring(ctx, diaryTidyModel, explainModel, (what) =>
      error(what, "Re-run `pnpm setup:ai`.")
    );
    if (wiringGap) {
      return wiringGap;
    }
    // A minimal generate call per model confirms the daemon actually answers — setup must not report
    // ok for a model the server would fail on (daemon down, model unpulled, or an empty response).
    for (const model of [diaryTidyModel, explainModel]) {
      const result = ctx.exec("ollama", ["run", model, "Reply with the single word: ok"]);
      if (result.code !== 0) {
        return error(
          `The Ollama model "${model}" did not answer.`,
          withOutputTail(
            "Ensure the Ollama daemon is running (`ollama serve`) and the model is pulled, then re-run `pnpm setup:ai`.",
            result
          )
        );
      }
      const shape = validateOllamaAnswer(result.stdout);
      if (!shape.ok) {
        return error(
          `The Ollama model "${model}" answered off-contract: ${shape.reason}.`,
          withOutputTail(`Re-pull it (\`ollama pull ${model}\`), then re-run \`pnpm setup:ai\`.`, result)
        );
      }
    }
    return ok();
  }
};
