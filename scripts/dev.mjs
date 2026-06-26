// One-command local dev: `pnpm dev`.
//
// Brings up the whole stack for iterative development:
//   1. Builds the shared packages once (`@whetstone/domain`, `@whetstone/contracts`). Both
//      the API server (run from source via `tsx`) and the web `tsc` build import them from
//      their `dist`, so they must exist before the dev servers start.
//   2. Runs the API server from source with reload (`@whetstone/server` `dev` = `tsx watch`)
//      and the Vite web dev server together, streaming both logs to this terminal.
//
// Because the server runs from source with reload, a newly landed route is live without a
// manual `build` — the stale-`dist/` 404 footgun is gone. Production is unaffected: it still
// runs the built `dist` via `pnpm --filter @whetstone/server start`. Tests, `build`, and
// `screenshots` do not use this script.
//
// Ctrl-C (or either dev server exiting) tears the whole group down so no orphan stays behind.
import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  return spawn(pnpm, args, { stdio: "inherit" });
}

const children = new Set();
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill();
  }
  process.exitCode = code;
}

function track(child) {
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    // The first dev server to exit takes the group down with it.
    shutdown(signal ? 1 : (code ?? 0));
  });
  return child;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

// 1. Build the shared packages first, then start the two dev servers.
const build = run(["--filter", "@whetstone/domain", "--filter", "@whetstone/contracts", "build"]);
build.on("exit", (code, signal) => {
  if (code !== 0 || signal) {
    shutdown(signal ? 1 : (code ?? 1));
    return;
  }
  if (shuttingDown) return;
  // 2. API server from source with reload + the web dev server, together.
  track(run(["--filter", "@whetstone/server", "dev"]));
  track(run(["--filter", "@whetstone/web", "dev"]));
});
