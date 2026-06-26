#!/usr/bin/env node
// Deterministic "should the Tester (QA) run, and with how much filing budget" decision for the
// whetstone tester workflow.
//
// The Tester explores the booted app on `main` and files `[Bug]` issues for what it finds. To keep
// it from flooding the backlog, its per-run filing budget is a pure function of the GitHub queue --
// the headroom below a cap on open `bug` issues -- not a choice left to a non-deterministic LLM
// session, the same way developer-next-action.mjs and reviewer-next-action.mjs decide their work.
// When the open-bug backlog is at the cap the Tester stays idle and lets the developer (bug-first)
// pay it down before more bugs are filed. The remaining guardrails -- reproduce before filing,
// dedupe against open `[Bug]`s, file nothing when nothing is found -- live in tester.agent.md.
//
// Usage:
//   node scripts/tester-next-action.mjs
//
// stdout: exactly one decision line -- one of:
//   test <budget>   explore main; file at most <budget> NEW, reproduced, de-duplicated [Bug]s
//   idle            the open-bug backlog is at the cap; file nothing this run
// stderr: human-readable diagnostics.
// exit:   0 on a clean decision; 1 only on a `gh`/tooling error.
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-tester.cmd).

import { execFileSync } from 'node:child_process';

// Never let the Tester grow the open-bug backlog past this, and never file more than the per-run cap
// in a single session (so one run cannot dump a pile of issues even when the backlog is empty).
const OPEN_BUG_CAP = 8;
const PER_RUN_CAP = 3;

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
}

let openBugs;
try {
  openBugs = ghJson([
    'issue', 'list', '--state', 'open', '--label', 'bug', '--limit', '200', '--json', 'number',
  ]).length;
} catch (err) {
  console.error(`tester-next-action: failed to query GitHub: ${err.message}`);
  process.exit(1);
}

const budget = Math.min(Math.max(0, OPEN_BUG_CAP - openBugs), PER_RUN_CAP);

if (budget === 0) {
  console.error(
    `tester-next-action: ${openBugs} open [Bug]s >= cap ${OPEN_BUG_CAP}; idle (let the developer clear the backlog).`,
  );
  console.log('idle');
  process.exit(0);
}

console.error(
  `tester-next-action: ${openBugs} open [Bug]s; budget=${budget} (open-bug cap ${OPEN_BUG_CAP}, per-run cap ${PER_RUN_CAP}).`,
);
console.log(`test ${budget}`);
process.exit(0);
