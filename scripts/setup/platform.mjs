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
