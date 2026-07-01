// Real `SetupContext` wiring: the one place setup touches the process, file system, and console.
// Kept thin and side-effect-only (no decision logic) so it reads as glue — the tested logic lives
// in runner.mjs and the steps, which reach the outside world only through this context. Excluded
// from coverage for the same reason as `src/**/index.ts`: it is a boundary of un-fakeable Node I/O.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { resolveCommand } from "./platform.mjs";

/**
 * @param {string} root  Absolute repository root.
 * @returns {import("./step.mjs").SetupContext}
 */
export function createContext(root) {
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
    log: (message) => console.log(message)
  };
}
