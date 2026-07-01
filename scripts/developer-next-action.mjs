#!/usr/bin/env node
// Deterministic "what should the developer do next" decision for the whetstone developer workflow.
//
// The developer completes ONE unit of work per run and otherwise stops. Whether that unit is "fix a
// PR the reviewer sent back" or "start the next issue" must be a pure function of the GitHub queue,
// not a choice left to a non-deterministic LLM session -- the same reason merge-approved-prs.mjs
// decides merges in code. The rule keeps work-in-progress at 1:
//
//   * a workflow PR is open and labeled `changes-requested`  -> fix that PR (reviewer handed it back)
//   * a workflow PR is open but not changes-requested        -> wait (in review or awaiting merge)
//   * no workflow PR, but an issue is still `in-progress`     -> resume THAT issue (a prior run started it
//                                                               but stopped before opening a PR). This is
//                                                               the work-in-progress guard: without it,
//                                                               selectNextIssue -- which only sees
//                                                               `ready-for-dev` -- skips the started issue
//                                                               and begins a SECOND one, leaving two issues
//                                                               `in-progress` at once and orphaning the first.
//   * no workflow PR and nothing in-progress                 -> implement the next dependency-ready issue
//                                                               (ready `[Bug]`s before `[Task]`s; see
//                                                               pick-next-issue.mjs `selectNextIssue`)
//   * none of the above                                      -> idle (nothing to do)
//
// A "workflow PR" is one this loop owns: a `dev/` head branch, or a PR carrying a review label. That
// keeps unrelated PRs (e.g. dependabot) from blocking the queue. Among changes-requested PRs the one
// closing the lowest-numbered issue is fixed first, matching the lowest-issue-first selection order.
//
// Usage:
//   node scripts/developer-next-action.mjs
//
// stdout: exactly one decision line -- one of:
//   fix <pr>        address the reviewer's change requests on this PR, then stop
//   wait <pr>       a PR is open and awaiting review/merge; do not start new work
//   implement <n>   no PR is open; implement this issue end to end
//   idle            nothing to do
// stderr: human-readable diagnostics.
// exit:   0 on a clean decision; 1 only on a `gh`/tooling error.
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-developer.cmd).

import { ghJson, selectNextIssue } from './pick-next-issue.mjs';

const REVIEW_LABELS = new Set(['needs-review', 'changes-requested', 'review-approved']);

function labelNames(pr) {
  return (pr.labels ?? []).map((l) => l.name);
}

// PRs this loop owns, sorted by the issue they close (then PR number) so a fix follows the same
// lowest-issue-first order as issue selection.
function workflowPrs(prs) {
  return prs
    .filter(
      (pr) =>
        (pr.headRefName ?? '').startsWith('dev/') ||
        labelNames(pr).some((n) => REVIEW_LABELS.has(n)),
    )
    .map((pr) => ({
      number: pr.number,
      labels: labelNames(pr),
      issue: pr.closingIssuesReferences?.[0]?.number ?? Infinity,
    }))
    .sort((a, b) => a.issue - b.issue || a.number - b.number);
}

function decide() {
  const prs = ghJson([
    'pr', 'list', '--state', 'open', '--limit', '200',
    '--json', 'number,labels,headRefName,closingIssuesReferences',
  ]);
  const mine = workflowPrs(prs);

  const changesRequested = mine.filter((pr) => pr.labels.includes('changes-requested'));
  if (changesRequested.length > 0) return { action: 'fix', pr: changesRequested[0].number, open: mine };
  if (mine.length > 0) return { action: 'wait', pr: mine[0].number, open: mine };

  // Work-in-progress guard (keeps WIP = 1). With no workflow PR open, an issue still labeled
  // `in-progress` was started by a prior run that stopped before opening a PR (crash/abort). Resume
  // THAT issue instead of letting selectNextIssue -- which only sees `ready-for-dev` -- skip it and
  // start a second one. Skipping is exactly what leaves two issues `in-progress` at once and strands
  // the first (it is no longer `ready-for-dev`, so it would never be picked again).
  const inProgress = ghJson([
    'issue', 'list', '--state', 'open', '--label', 'in-progress',
    '--limit', '200', '--json', 'number',
  ])
    .map((i) => i.number)
    .sort((a, b) => a - b);
  if (inProgress.length > 0) return { action: 'implement', issue: inProgress[0], open: mine, resume: true };

  const { next } = selectNextIssue();
  if (next != null) return { action: 'implement', issue: next, open: [] };
  return { action: 'idle', open: [] };
}

let d;
try {
  d = decide();
} catch (err) {
  console.error(`developer-next-action: failed to query GitHub: ${err.message}`);
  process.exit(1);
}

const openSummary = d.open.length
  ? `open workflow PRs: ${d.open.map((p) => `#${p.number}[${p.labels.join(',') || 'no-label'}]`).join(', ')}`
  : 'no open workflow PRs';

switch (d.action) {
  case 'fix':
    console.error(`developer-next-action: ${openSummary} -> fix PR #${d.pr} (changes-requested).`);
    console.log(`fix ${d.pr}`);
    break;
  case 'wait':
    console.error(
      `developer-next-action: ${openSummary} -> wait (PR #${d.pr} in review / awaiting merge); not starting new work.`,
    );
    console.log(`wait ${d.pr}`);
    break;
  case 'implement':
    console.error(
      `developer-next-action: ${openSummary} -> ${
        d.resume ? `resume in-progress issue #${d.issue}` : `implement issue #${d.issue}`
      }.`,
    );
    console.log(`implement ${d.issue}`);
    break;
  default:
    console.error('developer-next-action: nothing to do (no workflow PR, no dependency-ready issue).');
    console.log('idle');
}
process.exit(0);
