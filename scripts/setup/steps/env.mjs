// Base step 5 — scaffold `.env` from the committed `.env.example` when absent. No secrets are ever
// written: this only copies the example template (every value in it is optional and commented), so
// the file is ready for the user to paste their own keys into. An existing `.env` is left untouched
// (idempotent, never clobbers user keys). There is deliberately **no database step** — PGlite runs
// in-process, so nothing here provisions Postgres.

import { join } from "node:path";

import { error, missing, ok } from "../step.mjs";

const ENV_FILE = ".env";
const ENV_EXAMPLE = ".env.example";

/** @type {import("../step.mjs").Step} */
export const envStep = {
  id: "env",
  title: "Environment file (.env)",
  check(ctx) {
    if (ctx.fs.exists(join(ctx.root, ENV_FILE))) {
      return ok();
    }
    if (!ctx.fs.exists(join(ctx.root, ENV_EXAMPLE))) {
      return error(
        `Cannot scaffold ${ENV_FILE}: ${ENV_EXAMPLE} is missing.`,
        `Restore ${ENV_EXAMPLE} from version control, then re-run \`pnpm setup\`.`
      );
    }
    return missing(
      `No ${ENV_FILE} yet.`,
      `Copy ${ENV_EXAMPLE} to ${ENV_FILE} (this step does it for you; all values are optional).`
    );
  },
  provision(ctx) {
    ctx.fs.copyFile(join(ctx.root, ENV_EXAMPLE), join(ctx.root, ENV_FILE));
    return ok();
  },
  verify(ctx) {
    if (ctx.fs.exists(join(ctx.root, ENV_FILE))) {
      return ok();
    }
    return error(
      `${ENV_FILE} was not created.`,
      `Copy ${ENV_EXAMPLE} to ${ENV_FILE} manually.`
    );
  }
};
