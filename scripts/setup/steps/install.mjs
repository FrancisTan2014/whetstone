// Base step 2 — install workspace dependencies. Repo-scoped provisioning is done automatically
// (unlike the instruct-only toolchain). Idempotent: when `node_modules` already exists the check
// passes and `pnpm install` is skipped on re-run.

import { join } from "node:path";

import { error, missing, ok, withOutputTail } from "../step.mjs";

/** @type {import("../step.mjs").Step} */
export const installStep = {
  id: "install",
  title: "Install dependencies (pnpm install)",
  check(ctx) {
    if (ctx.fs.exists(join(ctx.root, "node_modules"))) {
      return ok();
    }
    return missing(
      "Workspace dependencies are not installed (no node_modules).",
      "Run `pnpm install` from the repository root."
    );
  },
  provision(ctx) {
    const result = ctx.exec("pnpm", ["install"]);
    if (result.code !== 0) {
      return error(
        "`pnpm install` failed.",
        withOutputTail(
          "Re-run `pnpm install` and read the error above; a stale lockfile or offline network is the usual cause.",
          result
        )
      );
    }
    return ok();
  },
  verify(ctx) {
    if (ctx.fs.exists(join(ctx.root, "node_modules"))) {
      return ok();
    }
    return error(
      "`pnpm install` reported success but node_modules is still missing.",
      "Run `pnpm install` manually and inspect its output."
    );
  }
};
