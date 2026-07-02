// Optional setup step (#382): make the LOCAL LLM coach work end to end with one command —
// `pnpm setup --coach`. It installs Ollama itself (consent-gated via #383's `installSystemTool`,
// never silently), pulls the local converse + "AI 解释" models, wires the non-secret coach env into
// the root `.env` (EXPLAIN_MODEL + COACH_*_TIER=cheap for a fully-local coach), and verifies each
// model actually answers through the daemon. Excluded from the base `pnpm setup` (heavy/network);
// every failure mode returns an actionable { what, remedy }, never a raw crash. Secrets are NEVER
// written here — the optional cloud judge (`COACH_API_KEY` + `COACH_ANALYZE_TIER=strong`) stays a
// documented manual step (docs/COACH.md).

import { envPath, readEnv, upsertEnvVars } from "../env-file.mjs";
import { installSystemTool } from "../installSystemTool.mjs";
import { error, isOk, missing, ok, withOutputTail } from "../step.mjs";

// The high-volume local converse tier's model (mirrors `defaultCheapModel` in coachAdapters.ts).
// Override which model to pull with COACH_MODEL; the runtime still serves llama3.1:8b by default.
const DEFAULT_CONVERSE_MODEL = "llama3.1:8b";
// The 文言-strong local model behind the lookup "AI 解释" aid (readExplainConfig / EXPLAIN_MODEL).
const DEFAULT_EXPLAIN_MODEL = "qwen2.5";

const OLLAMA_DOCS = "https://ollama.com/download";
const OLLAMA_REMEDY =
  "Install Ollama (https://ollama.com/download, or `winget install Ollama.Ollama` / " +
  "`brew install ollama` / `curl -fsSL https://ollama.com/install.sh | sh`), then re-run " +
  "`pnpm setup --coach`.";

/**
 * The local converse model to provision — `COACH_MODEL` override or the default.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string}
 */
function resolveConverseModel(ctx) {
  return ctx.env.COACH_MODEL ?? DEFAULT_CONVERSE_MODEL;
}

/**
 * The runtime-effective local "AI 解释" model. Precedence mirrors what the server actually serves at
 * boot: a process-env `EXPLAIN_MODEL` override wins (dotenv does not overwrite an already-set var),
 * then the value persisted in `.env`, then the default. check/verify pull and probe THIS exact model,
 * so setup never reports ready for a model the server would not use (e.g. `.env` names `qwen3` while
 * only the default `qwen2.5` is pulled).
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @returns {string}
 */
function resolveExplainModel(ctx) {
  return ctx.env.EXPLAIN_MODEL ?? readEnv(ctx).EXPLAIN_MODEL ?? DEFAULT_EXPLAIN_MODEL;
}

// The exact non-secret `.env` values `provision` writes to make the coach fully local. Both tiers must
// read `cheap` so the runtime routes coach calls to the local Ollama adapter instead of the default
// `analyze: "strong"` (which, with no cloud key, degrades to the deterministic fake). check/verify
// require these exact values — a stale `.env` that lacks them, or pins one to `strong`, is reported
// not-ready so `provision` upserts them.
const REQUIRED_COACH_ENV = Object.freeze({
  COACH_CONVERSE_TIER: "cheap",
  COACH_ANALYZE_TIER: "cheap"
});

/**
 * Validate that `.env` wires the exact non-secret values the runtime consumes for a fully-local coach:
 * `EXPLAIN_MODEL` naming the local model that was pulled/verified, and both `COACH_*_TIER=cheap` pins
 * that route every coach call to the local tier. Returns the first gap via `fail`, or null when fully
 * wired.
 *
 * @param {import("../step.mjs").SetupContext} ctx
 * @param {string} explainModel  The runtime-effective explain model (see resolveExplainModel).
 * @param {(what: string) => import("../step.mjs").StepResult} fail
 * @returns {import("../step.mjs").StepResult | null}
 */
function checkEnvWiring(ctx, explainModel, fail) {
  const env = readEnv(ctx);
  if (env.EXPLAIN_MODEL !== explainModel) {
    return fail(
      `.env does not wire EXPLAIN_MODEL=${explainModel} — the local "AI 解释" model the coach will use.`
    );
  }
  for (const [key, value] of Object.entries(REQUIRED_COACH_ENV)) {
    if (env[key] !== value) {
      return fail(
        `.env does not pin ${key}=${value}, so a coach call would route to the cloud/fake tier, not the local model.`
      );
    }
  }
  return null;
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
      : missing("Ollama was not found (required for the local coach + AI 解释).", OLLAMA_REMEDY),
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
 * Shape-check a local model's answer the way the runtime consumes it: `createOllamaChat` /
 * `createLlmExplainer` treat an empty response as "nothing to show". Setup must not report ready for
 * a model the server would get an empty answer from, so a blank/whitespace answer is off-contract.
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
export const coachStep = {
  id: "coach",
  title: "Coaching model (local Ollama LLM)",
  optional: true,
  capability: "coach",
  check(ctx) {
    if (!ollamaPresent(ctx)) {
      return missing(
        "Ollama was not found (required for the local coach + AI 解释).",
        OLLAMA_REMEDY
      );
    }
    const listed = ctx.exec("ollama", ["list"]);
    const pulled = (model) => listed.code === 0 && listed.stdout.includes(model);
    const converseModel = resolveConverseModel(ctx);
    if (!pulled(converseModel)) {
      return missing(
        `The local coach model "${converseModel}" is not pulled.`,
        `Run \`ollama pull ${converseModel}\` (or \`pnpm setup --coach\`).`
      );
    }
    const explainModel = resolveExplainModel(ctx);
    if (!pulled(explainModel)) {
      return missing(
        `The "AI 解释" model "${explainModel}" is not pulled.`,
        `Run \`ollama pull ${explainModel}\` (or \`pnpm setup --coach\`).`
      );
    }
    return (
      checkEnvWiring(ctx, explainModel, (what) => missing(what, "Run `pnpm setup --coach`.")) ?? ok()
    );
  },
  provision(ctx) {
    // Consent-gated: offer to install Ollama after an explicit Y (or `--yes`); on decline, no package
    // manager, or a non-interactive run, fall back to the instruct-only remedy unchanged.
    const ollamaReady = installSystemTool(ctx, OLLAMA_SPEC);
    if (!isOk(ollamaReady)) {
      return ollamaReady;
    }

    const converseModel = resolveConverseModel(ctx);
    const explainModel = resolveExplainModel(ctx);
    for (const model of [converseModel, explainModel]) {
      const fetched = ctx.exec("ollama", ["pull", model]);
      if (fetched.code !== 0) {
        return error(
          `Pulling the Ollama model "${model}" failed.`,
          withOutputTail(
            "Ensure the Ollama daemon is running (`ollama serve`) and check your network, then re-run `pnpm setup --coach`.",
            fetched
          )
        );
      }
    }

    const path = envPath(ctx);
    const content = ctx.fs.exists(path) ? ctx.fs.readText(path) : "";
    // Non-secret env only: name the local explain model and pin both coach tiers to `cheap` so the
    // coach runs fully local. NEVER write COACH_API_KEY — the cloud judge stays a manual opt-in.
    ctx.fs.writeText(
      path,
      upsertEnvVars(content, {
        EXPLAIN_MODEL: explainModel,
        COACH_CONVERSE_TIER: "cheap",
        COACH_ANALYZE_TIER: "cheap"
      })
    );
    return ok();
  },
  verify(ctx) {
    const converseModel = resolveConverseModel(ctx);
    const explainModel = resolveExplainModel(ctx);
    const wiringGap = checkEnvWiring(ctx, explainModel, (what) =>
      error(what, "Re-run `pnpm setup --coach`.")
    );
    if (wiringGap) {
      return wiringGap;
    }
    // A minimal generate call per model confirms the daemon actually answers — setup must not report
    // ok for a model the server would fail on (daemon down, model unpulled, or an empty response).
    for (const model of [converseModel, explainModel]) {
      const result = ctx.exec("ollama", ["run", model, "Reply with the single word: ok"]);
      if (result.code !== 0) {
        return error(
          `The Ollama model "${model}" did not answer.`,
          withOutputTail(
            "Ensure the Ollama daemon is running (`ollama serve`) and the model is pulled, then re-run `pnpm setup --coach`.",
            result
          )
        );
      }
      const shape = validateOllamaAnswer(result.stdout);
      if (!shape.ok) {
        return error(
          `The Ollama model "${model}" answered off-contract: ${shape.reason}.`,
          withOutputTail(`Re-pull it (\`ollama pull ${model}\`), then re-run \`pnpm setup --coach\`.`, result)
        );
      }
    }
    return ok();
  }
};
