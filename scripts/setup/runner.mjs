// The setup runner: ordering, execution, failure policy, and rendering. Pure given a
// `SetupContext` — every side effect (exec/fs/log) flows through `ctx`, so the whole orchestration
// is exercised with fake steps and a fake ctx (no real I/O) in the tests.
//
// Execution model per step: `check -> provision (only when check is not ok) -> verify`. A step that
// throws in any phase is caught and mapped to a structured `error` result (never a raw stack, never
// silently swallowed) — "a step that cannot determine status returns error, never ok".

import { error, isOk } from "./step.mjs";

/**
 * @typedef {import("./step.mjs").Step} Step
 * @typedef {import("./step.mjs").StepResult} StepResult
 * @typedef {import("./step.mjs").SetupContext} SetupContext
 */

/**
 * @typedef {object} StepOutcome
 * @property {Step} step
 * @property {StepResult | null} result  Final result, or null when the step was not run.
 * @property {boolean} skipped           True when a prior required failure aborted the run first.
 */

/**
 * @typedef {object} SetupArgs
 * @property {boolean} doctor            `--check` / `--doctor`: probe only, never mutate.
 * @property {boolean} voice             `--voice`: include optional voice-capability steps.
 * @property {boolean} coach             `--coach`: include optional coach-capability steps.
 * @property {string[]} unknown          Unrecognized flags (reported, non-fatal).
 */

const RECOGNIZED = new Map([
  ["--check", "doctor"],
  ["--doctor", "doctor"],
  ["--voice", "voice"],
  ["--coach", "coach"]
]);

/**
 * Parse the setup CLI flags. Order-independent; unknown flags are collected, not fatal.
 *
 * @param {string[]} argv  Flags only (already sliced past node + script path).
 * @returns {SetupArgs}
 */
export function parseArgs(argv) {
  const args = { doctor: false, voice: false, coach: false, unknown: /** @type {string[]} */ ([]) };
  for (const raw of argv) {
    const key = RECOGNIZED.get(raw);
    if (key) {
      args[key] = true;
    } else {
      args.unknown.push(raw);
    }
  }
  return args;
}

/**
 * Select the steps to run: every base (non-optional) step, plus optional steps whose `capability`
 * was opted in via a flag. The base `pnpm setup` therefore excludes all heavy/optional capabilities.
 *
 * @param {Step[]} steps
 * @param {{ voice: boolean, coach: boolean }} flags
 * @returns {Step[]}
 */
export function selectSteps(steps, flags) {
  const enabled = new Set();
  if (flags.voice) enabled.add("voice");
  if (flags.coach) enabled.add("coach");
  return steps.filter(
    (step) => !step.optional || (step.capability !== undefined && enabled.has(step.capability))
  );
}

/**
 * Call one step phase, mapping any thrown value to a structured `error` result so a misbehaving
 * step can never crash the runner or masquerade as `ok`.
 *
 * @param {(ctx: SetupContext) => StepResult} fn
 * @param {SetupContext} ctx
 * @param {Step} step
 * @param {string} phase
 * @returns {StepResult}
 */
function safeCall(fn, ctx, step, phase) {
  try {
    const result = fn(ctx);
    if (result === undefined || result === null || typeof result.status !== "string") {
      return error(
        `The "${step.title}" step returned no status during ${phase}.`,
        `This is a bug in scripts/setup/steps — ${step.id} must return a StepResult from ${phase}().`
      );
    }
    return result;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return error(
      `The "${step.title}" step threw during ${phase}.`,
      `Investigate scripts/setup/steps/${step.id}; underlying error: ${detail}`
    );
  }
}

/**
 * Run one step through check -> provision -> verify. In doctor mode only `check` runs.
 *
 * @param {Step} step
 * @param {SetupContext} ctx
 * @param {boolean} doctor
 * @returns {StepResult}
 */
function runStep(step, ctx, doctor) {
  const checked = safeCall(step.check, ctx, step, "check");
  if (doctor || isOk(checked)) {
    return checked;
  }
  if (!step.provision) {
    // Instruct-only prerequisite (e.g. the toolchain): nothing to provision, report as-is.
    return checked;
  }
  const provisioned = safeCall(step.provision, ctx, step, "provision");
  if (provisioned.status === "error") {
    return provisioned;
  }
  const verify = step.verify ?? step.check;
  return safeCall(verify, ctx, step, "verify");
}

/**
 * Execute the selected steps under the failure policy:
 * - **doctor**: run every `check`, never mutate, never abort. Exit non-zero only if a *required*
 *   step is not ok (optional-missing exits 0).
 * - **setup**: run each step; a *required* step that ends not-ok prints its remedy and **aborts**
 *   (remaining steps are marked not-run) with a non-zero exit; an *optional* failure is reported
 *   and the run continues. Re-running skips already-ok steps (idempotent/resumable).
 *
 * @param {Step[]} steps
 * @param {SetupContext} ctx
 * @param {{ doctor?: boolean }} [options]
 * @returns {{ exitCode: number, outcomes: StepOutcome[] }}
 */
export function runSetup(steps, ctx, options = {}) {
  const doctor = options.doctor === true;
  /** @type {StepOutcome[]} */
  const outcomes = [];
  let requiredFailed = false;
  let aborted = false;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (aborted) {
      outcomes.push({ step, result: null, skipped: true });
      continue;
    }
    ctx.log(`[setup] ${doctor ? "checking" : "running"}: ${step.title}`);
    const result = runStep(step, ctx, doctor);
    outcomes.push({ step, result, skipped: false });

    if (isOk(result)) {
      continue;
    }
    if (step.optional) {
      ctx.log(`[setup] optional step "${step.title}" not ready (${result.status}); continuing.`);
      continue;
    }
    requiredFailed = true;
    if (!doctor) {
      // Abort the mutating run so the user fixes the blocker before later steps build on it.
      // Doctor mode never aborts — it probes every step so the readiness report is complete.
      aborted = true;
      ctx.log(`[setup] required step "${step.title}" failed; stopping.`);
    }
  }

  return { exitCode: requiredFailed ? 1 : 0, outcomes };
}

const STATUS_MARKER = { ok: "[ ok ]", missing: "[MISS]", error: "[FAIL]" };

/**
 * @param {StepOutcome} outcome
 * @returns {string}
 */
function renderOutcome(outcome) {
  const { step, result, skipped } = outcome;
  if (skipped || result === null) {
    return `  [skip] ${step.title} — not run (a required step above stopped the run).`;
  }
  if (result.status === "ok") {
    return `  [ ok ] ${step.title} — ready.`;
  }
  const optionalNote = step.optional ? " (optional)" : "";
  const lines = [`  ${STATUS_MARKER[result.status]} ${step.title}${optionalNote}`];
  if (result.what) lines.push(`         what: ${result.what}`);
  if (result.remedy) lines.push(`         fix:  ${indentRemedy(result.remedy)}`);
  if (result.docs) lines.push(`         docs: ${result.docs}`);
  return lines.join("\n");
}

/**
 * Keep a multi-line remedy aligned under the "fix:" label.
 *
 * @param {string} remedy
 * @returns {string}
 */
function indentRemedy(remedy) {
  return remedy.split("\n").join("\n               ");
}

/**
 * Render the final human summary: a per-step readiness list followed by the next command. Every
 * run (success or partial) ends here so the output is always a guide, never a dead end.
 *
 * @param {StepOutcome[]} outcomes
 * @param {{ doctor?: boolean, exitCode: number }} context
 * @returns {string}
 */
export function formatSummary(outcomes, context) {
  const doctor = context.doctor === true;
  const failed = context.exitCode !== 0;
  const header = doctor ? "Setup doctor — capability readiness:" : "Setup summary:";
  const body = outcomes.map(renderOutcome).join("\n");

  let footer;
  if (doctor) {
    footer = failed
      ? "One or more required capabilities are missing. Address the items above, then run `pnpm setup`."
      : "All required capabilities are ready. Next: run `pnpm dev`.";
  } else if (failed) {
    footer =
      "Setup stopped. Fix the item(s) marked [MISS]/[FAIL] above, then re-run `pnpm setup` — it resumes from where it stopped.";
  } else {
    footer = "Setup complete. Next: run `pnpm dev`.";
  }

  return `${header}\n${body}\n\n${footer}`;
}
