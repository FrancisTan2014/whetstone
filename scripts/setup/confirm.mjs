// The consent seam's decision logic, isolated from any real I/O so it is fully unit-tested.
//
// Setup's policy is "consent-gated install, instruct-only fallback": before any heavy or system
// install a step asks `ctx.confirm(question)`, and only installs on an explicit yes. This factory
// holds the *decision*; the real prompt (stdin/tty) is injected here and wired for real in
// `context.mjs` (the un-fakeable boundary). Fakes inject `prompt`/`isTTY`/`yes` to cover every path.

/**
 * Build the `ctx.confirm` predicate from injected environment facts. Precedence:
 *   1. `yes` (pre-consent via `--yes`)  ⇒ always true, never prompts.
 *   2. not a TTY (non-interactive)      ⇒ always false, never prompts (safe default: decline).
 *   3. otherwise                        ⇒ prompt once and read a line; empty / `y` / `yes`
 *      (case-insensitive) is yes — the prompt text is `[Y/n]`, so the default (empty line) is YES.
 *
 * @param {object} deps
 * @param {boolean} deps.yes     Pre-consented (e.g. `--yes`): approve without prompting.
 * @param {boolean} deps.isTTY   Whether we can interactively prompt.
 * @param {(question: string) => string} deps.prompt  Show `question`, return the typed line.
 * @returns {(question: string) => boolean}
 */
export function makeConfirm({ yes, isTTY, prompt }) {
  return (question) => {
    if (yes) {
      return true;
    }
    if (!isTTY) {
      return false;
    }
    const answer = prompt(question).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  };
}
