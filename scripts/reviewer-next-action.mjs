#!/usr/bin/env node
// Deterministic "which PR should the reviewer take next" decision for the whetstone reviewer workflow.
//
// The reviewer reviews ONE pull request per run. Which PR is next must be a pure function of the
// GitHub queue -- the oldest open, non-draft PR labeled `needs-review` (and not `changes-requested`,
// which is waiting on the developer) -- not a choice left to a non-deterministic LLM session. `gh pr
// list` returns PRs newest-first, so an agent that grabs "the first one" reviews the LATEST PR instead
// of the oldest. This script removes that ambiguity, the same way merge-approved-prs.mjs decides merges
// and developer-next-action.mjs decides the developer's next unit.
//
// Usage:
//   node scripts/reviewer-next-action.mjs
//
// stdout: exactly one decision line -- one of:
//   review <pr>   review this PR against GUIDELINES.md, then stop
//   idle          no PR is waiting for review
// stderr: human-readable diagnostics.
// exit:   0 on a clean decision; 1 only on a `gh`/tooling error.
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-reviewer.cmd).

import { execFileSync } from 'node:child_process';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function labelNames(pr) {
  return (pr.labels ?? []).map((l) => l.name);
}

function selectNextReviewPr() {
  const prs = ghJson([
    'pr', 'list', '--state', 'open', '--limit', '200',
    '--json', 'number,labels,isDraft,createdAt',
  ]);
  const queue = prs
    // Open, non-draft, awaiting review, and not handed back to the developer.
    .filter((pr) => !pr.isDraft)
    .filter((pr) => {
      const names = labelNames(pr);
      return names.includes('needs-review') && !names.includes('changes-requested');
    })
    .map((pr) => ({ number: pr.number, createdAt: pr.createdAt }))
    // Oldest first: by creation time, then PR number as a stable tie-break.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  return { next: queue[0]?.number ?? null, queue };
}

let result;
try {
  result = selectNextReviewPr();
} catch (err) {
  console.error(`reviewer-next-action: failed to query GitHub: ${err.message}`);
  process.exit(1);
}

const { next, queue } = result;
if (next == null) {
  console.error('reviewer-next-action: no PR is waiting for review (needs-review, non-draft).');
  console.log('idle');
  process.exit(0);
}

console.error(
  `reviewer-next-action: review PR #${next}; queue=[${queue.map((p) => `#${p.number}`).join(', ')}]`,
);
console.log(`review ${next}`);
process.exit(0);
