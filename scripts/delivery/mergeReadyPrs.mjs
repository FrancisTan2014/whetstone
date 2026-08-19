#!/usr/bin/env node
// Deterministic merge step for the whetstone delivery workflow.
//
// The delivery agent marks a bounded, locally validated PR `merge-ready`. Whether it actually merges is
// decided here, in code, from the exact-head CI and repository-integrity gates in GUIDELINES.md -- never
// from a model's discretion.
//
// Usage:
//   node scripts/delivery/mergeReadyPrs.mjs            merge every eligible merge-ready PR
//   node scripts/delivery/mergeReadyPrs.mjs --pr 21    evaluate only PR #21
//   node scripts/delivery/mergeReadyPrs.mjs --dry-run  report what would merge, merge nothing
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-merge.cmd).

import { execFileSync } from "node:child_process";

import { mergeGateFailures, mergePullRequestArgs } from "./workflow.mjs";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const prFlagValue = argv[argv.indexOf("--pr") + 1];
const ONLY_PR =
  argv.includes("--pr") && Number.isInteger(Number(prFlagValue)) ? Number(prFlagValue) : null;

const PR_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "labels",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
  "closingIssuesReferences"
].join(",");

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A PR worth waiting on: explicitly ready, not blocked, open, not draft.
function isMergeCandidate(pr) {
  const labels = (pr.labels ?? []).map((l) => l.name);
  return (
    pr.state === "OPEN" &&
    !pr.isDraft &&
    labels.includes("merge-ready") &&
    !labels.includes("changes-requested")
  );
}

const repo = ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;

// GitHub computes mergeability asynchronously; poll briefly so a not-yet-computed UNKNOWN does not
// look like a failing gate for an otherwise-eligible PR.
function viewPr(number) {
  let pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
  for (
    let i = 0;
    i < 5 &&
    isMergeCandidate(pr) &&
    (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN");
    i++
  ) {
    sleepSync(2000);
    pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
  }
  return pr;
}

let numbers;
if (ONLY_PR != null) {
  numbers = [ONLY_PR];
} else {
  const list = ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    "merge-ready",
    "--json",
    "number"
  ]);
  numbers = list.map((p) => p.number);
}

if (numbers.length === 0) {
  console.log("No merge-ready pull requests to merge.");
  process.exit(0);
}

let merged = 0;
let skipped = 0;
let failed = 0;

for (const n of numbers) {
  const pr = viewPr(n);
  const reasons = mergeGateFailures(pr);

  if (reasons.length > 0) {
    skipped++;
    console.log(`SKIP   #${pr.number} ${pr.title}`);
    for (const r of reasons) console.log(`         - ${r}`);
    continue;
  }

  if (DRY_RUN) {
    console.log(`READY  #${pr.number} ${pr.title} (dry-run, not merging)`);
    continue;
  }

  try {
    gh(mergePullRequestArgs(pr, repo));
    merged++;
    console.log(`MERGED #${pr.number} ${pr.title}`);
  } catch (err) {
    failed++;
    console.error(`FAIL   #${pr.number} ${pr.title}: ${err.message}`);
  }
}

console.log(
  `\nDone. merged=${merged} skipped=${skipped} failed=${failed}${DRY_RUN ? " (dry-run)" : ""}.`
);
process.exit(failed > 0 ? 1 : 0);
