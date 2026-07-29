// Real `SetupContext` wiring: the one place setup touches the process, file system, and console.
// Kept thin and side-effect-only (no decision logic) so it reads as glue — the tested logic lives
// in runner.mjs and the steps, which reach the outside world only through this context. Excluded
// from coverage for the same reason as `src/**/index.ts`: it is a boundary of un-fakeable Node I/O.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readSync, statfsSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";

import { makeConfirm } from "./confirm.mjs";
import { resolveCommand } from "./platform.mjs";

/**
 * Read a persisted PATH value from the Windows registry (`reg query <key> /v Path`). Returns the raw
 * value string (possibly containing unexpanded `%VAR%` references), or "" when the key/value is
 * absent or the query fails. Boundary-only helper (never in tested decision logic).
 *
 * @param {string} key  Registry key, e.g. `HKCU\\Environment`.
 * @returns {string}
 */
function queryRegistryPath(key) {
  const result = spawnSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return "";
  }
  // A `Path` row looks like: `    Path    REG_EXPAND_SZ    C:\\a;C:\\b`. Split on the type token and
  // take the remainder as the value (it may itself contain spaces).
  const match = result.stdout.match(/\bPath\s+REG(?:_EXPAND)?_SZ\s+(.*)/i);
  return match ? match[1].trim() : "";
}

/**
 * Expand `%VAR%` references (REG_EXPAND_SZ values store them unexpanded) against the current process
 * environment, so a refreshed PATH holds concrete directories a child spawn can resolve.
 *
 * @param {string} value
 * @returns {string}
 */
function expandEnvRefs(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
}

/**
 * Re-read the persisted Machine + User `Path` from the registry and apply it to this process, so a
 * tool installed mid-run (whose installer only updated the persisted PATH) resolves for subsequent
 * child spawns. Win32-only; a no-op elsewhere (brew/apt/script installs land on an already-active
 * PATH). Lives in this excluded boundary — never in tested decision logic.
 *
 * @param {NodeJS.Platform} platform
 * @returns {void}
 */
function refreshProcessPath(platform) {
  if (platform !== "win32") {
    return;
  }
  const machine = queryRegistryPath(
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"
  );
  const user = queryRegistryPath("HKCU\\Environment");
  const combined = [machine, user]
    .map((value) => expandEnvRefs(value))
    .filter((value) => value.length > 0)
    .join(";");
  if (combined.length > 0) {
    // Windows treats PATH case-insensitively but Node exposes whichever casing the parent set; keep
    // both in sync so `process.env.PATH` reads and child spawns agree.
    process.env.Path = combined;
    process.env.PATH = combined;
  }
}

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
    refreshPath: () => refreshProcessPath(platform),
    resources: (path) => {
      // Free disk on the volume that will hold the venv/model, plus OS-available memory — the numbers
      // the voice step preflights before a multi-GiB download/load (#800). `statfsSync` reports the
      // filesystem holding `path`; `bavail` is the blocks available to an unprivileged process, so the
      // free bytes reflect what setup can actually use. A boundary of un-fakeable Node I/O (excluded
      // from coverage like the rest of this context), so the tested step drives it through a fake.
      const stats = statfsSync(path);
      return {
        diskFreeBytes: stats.bavail * stats.bsize,
        memoryAvailableBytes: freemem()
      };
    },
    log: (message) => console.log(message)
  };
}
