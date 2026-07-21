#!/usr/bin/env node
// Deterministic merge step for the whetstone reviewer workflow.
//
// The reviewer agent only records a verdict: it sets the `review-approved` label and posts a
// `reviewer-run-reviewed: <head-sha>` marker. Whether a PR actually merges is decided here, in code,
// as a pure function of the GUIDELINES.md merge gates -- not by a non-deterministic LLM session. This
// is what stops an approved-and-eligible PR from being left unmerged just because one reviewer run
// chose to "hand off to a human".
//
// Usage:
//   node scripts/merge-approved-prs.mjs            merge every eligible review-approved PR
//   node scripts/merge-approved-prs.mjs --pr 21    evaluate only PR #21
//   node scripts/merge-approved-prs.mjs --dry-run  report what would merge, merge nothing
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-merge.cmd).

import { execFileSync } from "node:child_process";

import { mergeGateFailures } from "./delivery-workflow.mjs";

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
  "comments",
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

// A PR worth waiting on: approved, not blocked, open, not draft.
function isMergeCandidate(pr) {
  const labels = (pr.labels ?? []).map((l) => l.name);
  return (
    pr.state === "OPEN" &&
    !pr.isDraft &&
    labels.includes("review-approved") &&
    !labels.includes("needs-review") &&
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
    "review-approved",
    "--json",
    "number"
  ]);
  numbers = list.map((p) => p.number);
}

if (numbers.length === 0) {
  console.log("No review-approved pull requests to merge.");
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
    gh(["pr", "merge", String(pr.number), "--repo", repo, "--merge", "--delete-branch"]);
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
