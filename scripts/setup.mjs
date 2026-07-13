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

// `--coach` / `pnpm setup:coach` retired (#602): the coach's local setup is gone, and the optional
// AI utilities (diary tidy + "AI 解释") now provision through `pnpm setup:ai`. Print the exact
// migration command and exit cleanly rather than silently doing nothing.
if (args.coachMoved) {
  console.log(
    "[setup] `pnpm setup:coach` has been removed. The optional local AI utilities (diary tidy + " +
      'the Reader "AI 解释" gloss) now install with:\n\n    pnpm setup:ai\n'
  );
  process.exit(0);
}

if (args.unknown.length > 0) {
  console.log(
    `[setup] ignoring unrecognized flag(s): ${args.unknown.join(", ")}. ` +
      "A bare `pnpm setup` installs only the deterministic base (no Ollama or models). " +
      "Use a baked-in script instead of a flag — `pnpm setup:minimal` (base only), " +
      "`pnpm setup:doctor` (--check), `pnpm setup:voice`, `pnpm setup:ai`, `pnpm setup:pdf`, " +
      "`pnpm setup:all` (every optional capability) — or forward a raw flag/env combo with " +
      "`pnpm run setup -- --<flag>` (e.g. `pnpm run setup -- --yes`). " +
      "Passing a flag to `pnpm setup` directly collides with pnpm's built-in `setup` command and fails."
  );
}

const ctx = createContext(repoRoot, { yes: args.yes });
const selected = selectSteps(steps, {
  voice: args.voice,
  ai: args.ai,
  pdf: args.pdf,
  all: args.all,
  minimal: args.minimal
});
const { exitCode, outcomes } = runSetup(selected, ctx, { doctor: args.doctor });

console.log(`\n${formatSummary(outcomes, { doctor: args.doctor, exitCode })}`);
process.exit(exitCode);
