// Base step 3 — build the workspace. The shared packages compile to `dist/`, which the server and
// web app import; the check treats a built `@whetstone/domain` as the proxy for "packages built",
// so a fresh clone provisions and a re-run skips.

import { join } from "node:path";

import { error, missing, ok, withOutputTail } from "../step.mjs";

const BUILD_MARKER = join("src", "packages", "domain", "dist", "index.js");

/** @type {import("../step.mjs").Step} */
export const buildStep = {
  id: "build",
  title: "Build workspace packages (pnpm build)",
  check(ctx) {
    if (ctx.fs.exists(join(ctx.root, BUILD_MARKER))) {
      return ok();
    }
    return missing(
      "Workspace packages have not been built (no dist output).",
      "Run `pnpm build` from the repository root."
    );
  },
  provision(ctx) {
    const result = ctx.exec("pnpm", ["build"]);
    if (result.code !== 0) {
      return error(
        "`pnpm build` failed.",
        withOutputTail(
          "Fix the compile error shown above (often a stale install — run `pnpm install` first), then re-run `pnpm setup`.",
          result
        )
      );
    }
    return ok();
  },
  verify(ctx) {
    if (ctx.fs.exists(join(ctx.root, BUILD_MARKER))) {
      return ok();
    }
    return error(
      "`pnpm build` reported success but no dist output was produced.",
      "Run `pnpm build` manually and inspect its output."
    );
  }
};
