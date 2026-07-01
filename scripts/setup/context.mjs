// Real `SetupContext` wiring: the one place setup touches the process, file system, and console.
// Kept thin and side-effect-only (no decision logic) so it reads as glue — the tested logic lives
// in runner.mjs and the steps, which reach the outside world only through this context. Excluded
// from coverage for the same reason as `src/**/index.ts`: it is a boundary of un-fakeable Node I/O.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

import { resolveCommand } from "./platform.mjs";

/**
 * @param {string} root  Absolute repository root.
 * @returns {import("./step.mjs").SetupContext}
 */
export function createContext(root) {
  const platform = process.platform;
  return {
    root,
    home: homedir(),
    platform,
    env: process.env,
    exec(command, args) {
      // Windows npm bins are `.cmd` shims; Node forbids spawning them without a shell, so run
      // through the shell on win32. Output is captured (not inherited) so a failing step can show a
      // trimmed tail instead of a raw dump.
      const result = spawnSync(resolveCommand(command, platform), args, {
        cwd: root,
        encoding: "utf8",
        shell: platform === "win32"
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error ? String(result.error.message) : "")
      };
    },
    fs: {
      exists: (path) => existsSync(path),
      readDir: (path) => (existsSync(path) ? readdirSync(path) : []),
      copyFile: (from, to) => copyFileSync(from, to)
    },
    log: (message) => console.log(message)
  };
}
