// A reusable, consent-gated installer for a *system* prerequisite (a binary the app needs that
// `pnpm install` cannot provide — e.g. Python, and later Ollama). It turns the framework policy
// ("never silently install a system tool; install only after an explicit Y/N, else instruct") into
// one small tested seam a step can call, instead of every step re-implementing detect/consent/run.
//
// Deliberately NOT a package-manager abstraction: it knows only the one native manager per platform
// a spec declares (winget / brew / apt / an official script) and always degrades to an instruct-only
// remedy. It never throws and never installs without a yes (or `--yes` pre-consent via `ctx.confirm`).

import { error, isOk, missing, ok, withOutputTail } from "./step.mjs";

/**
 * A per-platform install recipe: the package manager to detect + drive, and the args that install
 * the tool. `detect` probes the manager's presence (its exit code 0 means available).
 *
 * @typedef {object} InstallPlan
 * @property {string} manager     Package-manager command (e.g. "winget", "brew", "apt-get").
 * @property {string[]} args      Args that install the tool (e.g. ["install", "Python.Python.3"]).
 * @property {string[]} [detect]  Args that probe the manager's presence (default ["--version"]).
 */

/**
 * Describes one installable system tool. `check` is the readiness probe (reused as the source of
 * truth); `remedy` (+ optional `docs`) is the manual instruct-only fallback shown whenever we don't
 * auto-install; `plans` supplies the native install recipe per platform (absent platform ⇒ manual).
 *
 * @typedef {object} InstallSpec
 * @property {string} name        Human tool name (used in the default consent question + logs).
 * @property {(ctx: import("./step.mjs").SetupContext) => import("./step.mjs").StepResult} check
 * @property {string} remedy      Manual, instruct-only remedy (the fallback).
 * @property {string} [docs]      Optional docs URL, surfaced when no package manager is available.
 * @property {Partial<Record<NodeJS.Platform, InstallPlan>>} plans  Per-platform install recipe.
 * @property {string} [question]  Consent prompt (default `Install <name> now? [Y/n]`).
 * @property {string} [what]      Not-ready description (default `<name> is required but was not found.`).
 */

/**
 * Ensure a system tool is present, asking consent before installing. Five outcomes, none of which
 * throw:
 *   1. `check` is ok                         ⇒ `ok()` (already present, nothing to do).
 *   2. no plan for this platform, or its package manager is absent ⇒ `missing` + docs (instruct-only).
 *   3. `ctx.confirm(question)` is false      ⇒ `missing` (instruct-only; user declined).
 *   4. install runs but exits non-zero       ⇒ `error` with the output tail (instruct-only fallback).
 *   5. install exits zero                    ⇒ `ok()`.
 *
 * @param {import("./step.mjs").SetupContext} ctx
 * @param {InstallSpec} spec
 * @returns {import("./step.mjs").StepResult}
 */
export function installSystemTool(ctx, spec) {
  const ready = spec.check(ctx);
  if (isOk(ready)) {
    return ready;
  }

  const what = spec.what ?? `${spec.name} is required but was not found.`;
  const plan = spec.plans[ctx.platform];
  const managerPresent =
    plan !== undefined && ctx.exec(plan.manager, plan.detect ?? ["--version"]).code === 0;
  if (!managerPresent) {
    // No supported package manager here: the user must install it themselves. Surface the docs URL.
    return missing(what, spec.remedy, spec.docs);
  }

  const question = spec.question ?? `Install ${spec.name} now? [Y/n]`;
  if (!ctx.confirm(question)) {
    // Consent declined — respect it and fall back to instructions (no docs noise; they chose manual).
    return missing(what, spec.remedy);
  }

  ctx.log(`[setup] installing ${spec.name} via ${plan.manager}...`);
  const result = ctx.exec(plan.manager, plan.args);
  if (result.code !== 0) {
    return error(what, withOutputTail(spec.remedy, result), spec.docs);
  }

  // The install succeeded — but on Windows the freshly-installed binary is invisible to THIS process:
  // the installer only updates the persisted (registry) PATH, while our already-running process and
  // every child `spawnSync` keep the PATH captured at launch. That is the `spawnSync <tool> ENOENT`
  // in #423, where the very next step tries to *use* the tool we just installed. Refresh PATH from
  // the registry and re-probe so install->use completes in one run; if it still doesn't resolve, name
  // the real cause — a stale shell PATH — rather than letting a downstream step blame something else.
  if (ctx.platform === "win32") {
    ctx.refreshPath();
    if (!isOk(spec.check(ctx))) {
      return missing(
        `${spec.name} was installed but is not on this terminal's PATH yet.`,
        `Open a new terminal (so it picks up the updated PATH) and re-run the same command, ` +
          `or add ${spec.name} to your PATH manually.`
      );
    }
  }
  return ok();
}
