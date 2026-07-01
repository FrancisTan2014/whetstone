// The declarative setup-step contract.
//
// Each setup concern is one isolated descriptor. The runner (`runner.mjs`) orders and executes
// them; steps are independent and unaware of each other, so a future dependency is added by
// dropping in one file under `steps/` — never by editing a monolith (open/closed).
//
// A step reports outcome as **structured data**, never a bare throw: a `StepResult` carries the
// concrete condition (`what`) and the exact next action (`remedy`), so the runner can render a
// clear, actionable block instead of a stack trace. This mirrors whetstone's fail-loud ethos.

/**
 * @typedef {"ok" | "missing" | "error"} StepStatus
 *   - `ok`      the capability is present/provisioned.
 *   - `missing` a prerequisite is absent (may be provisionable, or instruct-only).
 *   - `error`   the step ran but failed, or could not determine status.
 */

/**
 * @typedef {object} StepResult
 * @property {StepStatus} status
 * @property {string} [what]   Human description of the concrete condition (required when not ok).
 * @property {string} [remedy] The exact next action — a command, env var, or instruction
 *                             (required when not ok).
 * @property {string} [docs]   Optional docs link for more detail.
 */

/**
 * The execution context handed to every step. All side effects flow through it so steps stay
 * unit-testable with fakes (no real process/fs/console reached directly).
 *
 * @typedef {object} SetupContext
 * @property {string} root        Absolute repository root the commands run in.
 * @property {NodeJS.Platform} platform  `process.platform` (steps branch win32/posix through helpers).
 * @property {Record<string, string | undefined>} env  Environment variables.
 * @property {(command: string, args: string[]) => ExecResult} exec  Run an external command synchronously.
 * @property {SetupFs} fs         Minimal file-system surface.
 * @property {(message: string) => void} log  Progress logger.
 */

/**
 * @typedef {object} ExecResult
 * @property {number} code    Exit code (non-zero = failure).
 * @property {string} stdout  Captured stdout.
 * @property {string} stderr  Captured stderr.
 */

/**
 * @typedef {object} SetupFs
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => string} readText  UTF-8 contents (throws if absent).
 * @property {(path: string, content: string) => void} writeText  Write UTF-8 contents.
 * @property {(from: string, to: string) => void} copyFile
 */

/**
 * A single setup concern. `provision` is optional: a system-prerequisite step (Node/pnpm/Python)
 * omits it so the runner reports "missing + how to obtain it" instead of force-installing.
 *
 * @typedef {object} Step
 * @property {string} id
 * @property {string} title
 * @property {boolean} [optional]     Optional steps never fail the run; excluded from the base set.
 * @property {string} [capability]    Ties an optional step to a `--<capability>` opt-in flag.
 * @property {(ctx: SetupContext) => StepResult} check    Non-mutating readiness probe.
 * @property {(ctx: SetupContext) => StepResult} [provision]  Idempotent provisioning (run only if check is not ok).
 * @property {(ctx: SetupContext) => StepResult} [verify]  Non-mutating post-provision probe (defaults to `check`).
 */

/** @returns {StepResult} */
export function ok() {
  return { status: "ok" };
}

/**
 * @param {string} what
 * @param {string} remedy
 * @param {string} [docs]
 * @returns {StepResult}
 */
export function missing(what, remedy, docs) {
  return docs ? { status: "missing", what, remedy, docs } : { status: "missing", what, remedy };
}

/**
 * @param {string} what
 * @param {string} remedy
 * @param {string} [docs]
 * @returns {StepResult}
 */
export function error(what, remedy, docs) {
  return docs ? { status: "error", what, remedy, docs } : { status: "error", what, remedy };
}

/**
 * @param {StepResult} result
 * @returns {boolean}
 */
export function isOk(result) {
  return result.status === "ok";
}

/**
 * Append a trimmed tail of captured output to a remedy so a failing shell-out keeps its evidence
 * without dumping a full log. Empty output yields the remedy unchanged.
 *
 * @param {string} remedy
 * @param {ExecResult} result
 * @param {number} [maxLines]
 * @returns {string}
 */
export function withOutputTail(remedy, result, maxLines = 8) {
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (raw === "") {
    return remedy;
  }
  const tail = raw.split("\n").slice(-maxLines).join("\n");
  return `${remedy}\n\n  Last output:\n${tail}`;
}
