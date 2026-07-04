// Cross-platform command resolution. Node CLIs shipped as npm bins are `.cmd` shims on Windows
// (`pnpm` -> `pnpm.cmd`), which `child_process.spawn` cannot launch by their bare name without a
// shell. Resolving the concrete binary here keeps the win32/posix branch in one tested place —
// the same reason `scripts/dev.mjs` picks `pnpm.cmd` on win32 — so steps just call
// `ctx.exec("pnpm", ...)` and stay platform-agnostic.

// The Node-ecosystem CLIs whetstone shells out to during setup that ship a `.cmd` shim on Windows.
const WINDOWS_CMD_SHIMS = new Set(["pnpm", "npx", "npm", "corepack"]);

/**
 * @param {string} command
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function resolveCommand(command, platform) {
  if (platform === "win32" && WINDOWS_CMD_SHIMS.has(command)) {
    return `${command}.cmd`;
  }
  return command;
}

/**
 * Spawn options for launching a Node-ecosystem `.cmd` shim (e.g. `pnpm.cmd`) by name with its output
 * streamed to this terminal. On Windows the shim must go through a shell — since the fix for
 * CVE-2024-27980 ("BatBadBut"), Node refuses to spawn a `.cmd`/`.bat` directly and throws
 * `spawn EINVAL` (strict on Node 24) — so `shell: true`; on posix the real binary spawns directly
 * with no shell. Keeping this win32/posix branch here (beside `resolveCommand`) is why
 * `scripts/dev.mjs` no longer re-derives it inline.
 *
 * @param {NodeJS.Platform} platform
 * @returns {{ stdio: "inherit", shell: boolean }}
 */
export function cmdShimSpawnOptions(platform) {
  return { stdio: "inherit", shell: platform === "win32" };
}
