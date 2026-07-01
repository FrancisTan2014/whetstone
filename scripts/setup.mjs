// `pnpm setup` (and `pnpm setup:doctor` via `--check`): the one-command bootstrap entry point.
// Thin wiring — it parses flags, builds the real context, selects steps, runs them, prints the
// summary, and exits with the runner's code. All decisions live in runner.mjs and the steps.
// Excluded from coverage like `src/**/index.ts`: it only wires tested pieces to Node's argv/exit.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createContext } from "./setup/context.mjs";
import { formatSummary, parseArgs, runSetup, selectSteps } from "./setup/runner.mjs";
import { steps } from "./setup/steps/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = parseArgs(process.argv.slice(2));
if (args.unknown.length > 0) {
  console.log(
    `[setup] ignoring unrecognized flag(s): ${args.unknown.join(", ")}. ` +
      "Known flags: --check (doctor), --voice, --coach."
  );
}

const ctx = createContext(repoRoot);
const selected = selectSteps(steps, { voice: args.voice, coach: args.coach });
const { exitCode, outcomes } = runSetup(selected, ctx, { doctor: args.doctor });

console.log(`\n${formatSummary(outcomes, { doctor: args.doctor, exitCode })}`);
process.exit(exitCode);
