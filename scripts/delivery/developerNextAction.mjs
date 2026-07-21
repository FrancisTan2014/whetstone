#!/usr/bin/env node
// Deterministic "what should the developer do next" decision for the whetstone developer workflow.
//
// The developer completes ONE unit of work per run and otherwise stops. Whether that unit is "fix a
// PR the reviewer sent back" or "start the next issue" must be a pure function of the GitHub queue,
// not a choice left to a non-deterministic LLM session -- the same reason mergeApprovedPrs.mjs
// decides merges in code. The rule keeps work-in-progress at 1:
//
//   * a workflow PR is open and labeled `changes-requested`  -> fix that PR (reviewer handed it back)
//   * a workflow PR has a completed failing blocking check   -> fix/triage that exact-head CI failure
//   * a workflow PR is otherwise open                         -> wait (in review or awaiting merge)
//   * no workflow PR, but an issue is still `in-progress`     -> resume THAT issue (a prior run started it
//                                                               but stopped before opening a PR). This is
//                                                               the work-in-progress guard: without it,
//                                                               selectNextIssue -- which only sees
//                                                               `ready-for-dev` -- skips the started issue
//                                                               and begins a SECOND one, leaving two issues
//                                                               `in-progress` at once and orphaning the first.
//   * no workflow PR and nothing in-progress                 -> implement the next dependency-ready issue
//                                                               (ready `[Bug]`s before `[Task]`s; see
//                                                               pickNextIssue.mjs `selectNextIssue`)
//   * none of the above                                      -> idle (nothing to do)
//
// A "workflow PR" is one this loop owns: a `dev/` head branch, or a PR carrying a review label. That
// keeps unrelated PRs (e.g. dependabot) from blocking the queue. Among changes-requested PRs the one
// closing the lowest-numbered issue is fixed first, matching the lowest-issue-first selection order.
//
// Usage:
//   node scripts/delivery/developerNextAction.mjs
//
// stdout: exactly one decision line -- one of:
//   fix <pr>        address the reviewer's change requests on this PR, then stop
//   fix-ci <pr>     triage a completed failing blocking check on this PR, then stop
//   wait <pr>       a PR is open and awaiting review/merge; do not start new work
//   implement <n>   no PR is open; implement this issue end to end
//   idle            nothing to do
// stderr: human-readable diagnostics.
// exit:   0 on a clean decision; 1 only on a `gh`/tooling error.
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-developer.cmd).

import { ghJson, selectNextIssue } from "./pickNextIssue.mjs";
import { selectDeveloperPrAction } from "./workflow.mjs";

function decide() {
  const prs = ghJson([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,labels,headRefName,isDraft,closingIssuesReferences,statusCheckRollup"
  ]);
  const pullRequestDecision = selectDeveloperPrAction(prs);
  if (pullRequestDecision.action !== "none") return pullRequestDecision;

  // Work-in-progress guard (keeps WIP = 1). With no workflow PR open, an issue still labeled
  // `in-progress` was started by a prior run that stopped before opening a PR (crash/abort). Resume
  // THAT issue instead of letting selectNextIssue -- which only sees `ready-for-dev` -- skip it and
  // start a second one. Skipping is exactly what leaves two issues `in-progress` at once and strands
  // the first (it is no longer `ready-for-dev`, so it would never be picked again).
  const inProgress = ghJson([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    "in-progress",
    "--limit",
    "200",
    "--json",
    "number"
  ])
    .map((i) => i.number)
    .sort((a, b) => a - b);
  if (inProgress.length > 0)
    return { action: "implement", issue: inProgress[0], open: [], resume: true };

  const { next } = selectNextIssue();
  if (next != null) return { action: "implement", issue: next, open: [] };
  return { action: "idle", open: [] };
}

let d;
try {
  d = decide();
} catch (err) {
  console.error(`developerNextAction: failed to query GitHub: ${err.message}`);
  process.exit(1);
}

const openSummary = d.open.length
  ? `open workflow PRs: ${d.open.map((p) => `#${p.number}[${p.labels.join(",") || "no-label"}]`).join(", ")}`
  : "no open workflow PRs";

switch (d.action) {
  case "fix":
    console.error(`developerNextAction: ${openSummary} -> fix PR #${d.pr} (changes-requested).`);
    console.log(`fix ${d.pr}`);
    break;
  case "fix-ci":
    console.error(
      `developerNextAction: ${openSummary} -> fix-ci PR #${d.pr} (completed blocking check failed).`
    );
    console.log(`fix-ci ${d.pr}`);
    break;
  case "wait":
    console.error(
      `developerNextAction: ${openSummary} -> wait (PR #${d.pr} in review / awaiting merge); not starting new work.`
    );
    console.log(`wait ${d.pr}`);
    break;
  case "implement":
    console.error(
      `developerNextAction: ${openSummary} -> ${
        d.resume ? `resume in-progress issue #${d.issue}` : `implement issue #${d.issue}`
      }.`
    );
    console.log(`implement ${d.issue}`);
    break;
  default:
    console.error(
      "developerNextAction: nothing to do (no workflow PR, no dependency-ready issue)."
    );
    console.log("idle");
}
process.exit(0);
