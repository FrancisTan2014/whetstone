// Real `SetupContext` wiring: the one place setup touches the process, file system, and console.
// Kept thin and side-effect-only (no decision logic) so it reads as glue — the tested logic lives
// in runner.mjs and the steps, which reach the outside world only through this context. Excluded
// from coverage for the same reason as `src/**/index.ts`: it is a boundary of un-fakeable Node I/O.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readSync, writeFileSync } from "node:fs";

import { makeConfirm } from "./confirm.mjs";
import { resolveCommand } from "./platform.mjs";

/**
 * Read a single line from stdin synchronously (setup is spawnSync-synchronous throughout, so there
 * is no event loop to await). Prints the question, then blocks on one `readSync` from fd 0. Returns
 * `null` on EOF (zero bytes — closed/redirected stdin) or a read error, so `makeConfirm` DECLINES
 * rather than treating an unavailable stdin as the `[Y/n]` empty-line default. Lives only in this
 * excluded boundary — never in tested decision logic.
 *
 * @param {string} question
 * @returns {string | null}
 */
function promptLine(question) {
  process.stdout.write(`${question} `);
  const buffer = Buffer.alloc(256);
  try {
    const bytes = readSync(0, buffer, 0, buffer.length, null);
    return bytes === 0 ? null : buffer.toString("utf8", 0, bytes);
  } catch {
    return null;
  }
}

/**
 * @param {string} root  Absolute repository root.
 * @param {{ yes?: boolean }} [options]  `yes` pre-consents every `ctx.confirm` (the `--yes` flag).
 * @returns {import("./step.mjs").SetupContext}
 */
export function createContext(root, options = {}) {
  const platform = process.platform;
  return {
    root,
    platform,
    env: process.env,
    exec(command, args) {
      // Only the Windows npm `.cmd` shims (pnpm/npx) need a shell — Node forbids spawning them
      // without one. Everything else (python, node) is spawned directly so `-c` scripts and other
      // args pass through verbatim, without cmd.exe re-quoting. Output is captured (not inherited)
      // so a failing step can show a trimmed tail instead of a raw dump.
      const resolved = resolveCommand(command, platform);
      const result = spawnSync(resolved, args, {
        cwd: root,
        encoding: "utf8",
        shell: resolved.endsWith(".cmd")
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error ? String(result.error.message) : "")
      };
    },
    fs: {
      exists: (path) => existsSync(path),
      readText: (path) => readFileSync(path, "utf8"),
      writeText: (path, content) => writeFileSync(path, content),
      copyFile: (from, to) => copyFileSync(from, to)
    },
    confirm: makeConfirm({
      yes: options.yes === true,
      // Interactivity is gated on stdin (the line we read), not stdout: a redirected/closed stdin
      // (e.g. `pnpm setup:voice < NUL`) must decline even when stdout is still a terminal, so a
      // non-interactive run can never auto-consent to a system install. Require both to be safe.
      isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
      prompt: promptLine
    }),
    log: (message) => console.log(message)
  };
}
