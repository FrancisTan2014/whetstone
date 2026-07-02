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
 *   3. otherwise                        ⇒ prompt once and read a line. A `null` line (EOF, or a
 *      closed / redirected / interrupted stdin) DECLINES — only a real line consents, where empty /
 *      `y` / `yes` (case-insensitive) is yes (the prompt is `[Y/n]`, so a typed empty line is YES).
 *
 * @param {object} deps
 * @param {boolean} deps.yes     Pre-consented (e.g. `--yes`): approve without prompting.
 * @param {boolean} deps.isTTY   Whether we can interactively prompt (interactive stdin).
 * @param {(question: string) => (string | null)} deps.prompt  Show `question`, return the typed line,
 *   or `null` on EOF / read failure (which declines — never falls through to the empty-line default).
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
    const line = prompt(question);
    // A null line means no interactive input was available (EOF / closed stdin) — decline rather
    // than map it to the `[Y/n]` empty-line default, so a redirected stdin can never auto-consent.
    if (line === null) {
      return false;
    }
    const answer = line.trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  };
}
