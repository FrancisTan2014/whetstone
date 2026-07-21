#!/usr/bin/env node
// Deterministic "which PR should the reviewer take next" decision for the whetstone reviewer workflow.
//
// The reviewer reviews ONE pull request per run. Which PR is next must be a pure function of the
// GitHub queue -- the oldest open, non-draft PR awaiting review, including an approved PR whose
// reviewed SHA is stale after a push. `changes-requested` and explicitly blocked PRs remain with the
// developer/maintainer. The deterministic stale-SHA recovery prevents a forgotten label transition
// from freezing WIP forever.
//
// Usage:
//   node scripts/delivery/reviewerNextAction.mjs
//
// stdout: exactly one decision line -- one of:
//   review <pr>   review this PR against GUIDELINES.md, then stop
//   idle          no PR is waiting for review
// stderr: human-readable diagnostics.
// exit:   0 on a clean decision; 1 only on a `gh`/tooling error.
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-reviewer.cmd).

import { execFileSync } from "node:child_process";

import { selectReviewQueue } from "./workflow.mjs";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function selectNextReviewPr() {
  const prs = ghJson([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,labels,isDraft,createdAt,headRefOid,comments"
  ]);
  const queue = selectReviewQueue(prs);
  return { next: queue[0]?.number ?? null, queue };
}

let result;
try {
  result = selectNextReviewPr();
} catch (err) {
  console.error(`reviewerNextAction: failed to query GitHub: ${err.message}`);
  process.exit(1);
}

const { next, queue } = result;
if (next == null) {
  console.error("reviewerNextAction: no PR is waiting for review (needs-review, non-draft).");
  console.log("idle");
  process.exit(0);
}

console.error(
  `reviewerNextAction: review PR #${next}; queue=[${queue.map((p) => `#${p.number}`).join(", ")}]`
);
console.log(`review ${next}`);
process.exit(0);
