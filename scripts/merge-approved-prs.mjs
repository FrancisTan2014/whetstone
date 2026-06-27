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

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const prFlagValue = argv[argv.indexOf('--pr') + 1];
const ONLY_PR = argv.includes('--pr') && Number.isInteger(Number(prFlagValue)) ? Number(prFlagValue) : null;

const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PR_FIELDS = [
  'number', 'title', 'state', 'isDraft', 'labels', 'headRefOid',
  'mergeable', 'mergeStateStatus', 'statusCheckRollup', 'comments', 'closingIssuesReferences',
].join(',');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The latest comment carrying a reviewer-run-reviewed marker wins (a re-review supersedes an older one).
function reviewedSha(comments) {
  const re = /reviewer-run-reviewed:\s*([0-9a-f]{7,40})/gi;
  let sha = null;
  for (const c of comments ?? []) {
    const body = c.body ?? '';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) sha = m[1];
  }
  return sha;
}

function checkFailures(rollup) {
  const failures = [];
  if (!rollup || rollup.length === 0) {
    failures.push('no required checks reported');
    return failures;
  }
  for (const c of rollup) {
    // Checks that advertise themselves as non-blocking (e.g. "Lighthouse CI (informational,
    // non-blocking)") must never gate a merge -- otherwise a flaky informational check leaves an
    // approved, otherwise-green PR unmergeable forever. They also make mergeStateStatus UNSTABLE,
    // which is accepted below.
    if (isNonBlockingCheck(c)) continue;
    if (c.__typename === 'StatusContext') {
      if (c.state !== 'SUCCESS') failures.push(`status "${c.context}" is ${c.state}`);
      continue;
    }
    // CheckRun (and any other run-style entry)
    if (c.status !== 'COMPLETED') failures.push(`check "${c.name}" is ${c.status}`);
    else if (!PASSING_CHECK_CONCLUSIONS.has(c.conclusion)) failures.push(`check "${c.name}" is ${c.conclusion}`);
  }
  return failures;
}

// A check is non-blocking when its own name/context says so. Such checks are informational and are
// excluded from the merge gate (and from the mergeStateStatus check, since they make it UNSTABLE).
function isNonBlockingCheck(c) {
  const label = (c.name ?? c.context ?? '').toLowerCase();
  return label.includes('non-blocking');
}

// Returns the list of failing gates for a PR; empty list means every GUIDELINES merge gate passes.
function failingGates(pr) {
  const reasons = [];
  const labels = (pr.labels ?? []).map((l) => l.name);

  if (pr.state !== 'OPEN') reasons.push(`state is ${pr.state}`);
  if (pr.isDraft) reasons.push('PR is a draft');

  if (!labels.includes('review-approved')) reasons.push('missing review-approved label');
  if (labels.includes('needs-review')) reasons.push('has needs-review label');
  if (labels.includes('changes-requested')) reasons.push('has changes-requested label');

  const marker = reviewedSha(pr.comments);
  if (!marker) {
    reasons.push('no reviewer-run-reviewed marker');
  } else {
    const head = (pr.headRefOid ?? '').toLowerCase();
    const mk = marker.toLowerCase();
    if (head !== mk && !head.startsWith(mk)) {
      reasons.push(`head ${head.slice(0, 12)} != reviewed ${mk.slice(0, 12)}`);
    }
  }

  reasons.push(...checkFailures(pr.statusCheckRollup));

  if (pr.mergeable !== 'MERGEABLE') reasons.push(`mergeable is ${pr.mergeable}`);
  // CLEAN = all good; UNSTABLE = mergeable but a non-required (here: non-blocking, see above) check is
  // failing/pending. Real blocking-check failures are caught by checkFailures, and conflicts/behind/
  // blocked surface as DIRTY/BEHIND/BLOCKED, so accept only these two mergeable states.
  if (pr.mergeStateStatus !== 'CLEAN' && pr.mergeStateStatus !== 'UNSTABLE') {
    reasons.push(`merge state is ${pr.mergeStateStatus}`);
  }

  if (!pr.closingIssuesReferences || pr.closingIssuesReferences.length === 0) {
    reasons.push('no linked closing issue');
  }

  return reasons;
}

// A PR worth waiting on: approved, not blocked, open, not draft.
function isMergeCandidate(pr) {
  const labels = (pr.labels ?? []).map((l) => l.name);
  return pr.state === 'OPEN' && !pr.isDraft
    && labels.includes('review-approved')
    && !labels.includes('needs-review') && !labels.includes('changes-requested');
}

const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;

// GitHub computes mergeability asynchronously; poll briefly so a not-yet-computed UNKNOWN does not
// look like a failing gate for an otherwise-eligible PR.
function viewPr(number) {
  let pr = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
  for (let i = 0; i < 5 && isMergeCandidate(pr) && (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN'); i++) {
    sleepSync(2000);
    pr = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
  }
  return pr;
}

let numbers;
if (ONLY_PR != null) {
  numbers = [ONLY_PR];
} else {
  const list = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--label', 'review-approved', '--json', 'number']);
  numbers = list.map((p) => p.number);
}

if (numbers.length === 0) {
  console.log('No review-approved pull requests to merge.');
  process.exit(0);
}

let merged = 0;
let skipped = 0;
let failed = 0;

for (const n of numbers) {
  const pr = viewPr(n);
  const reasons = failingGates(pr);

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
    gh(['pr', 'merge', String(pr.number), '--repo', repo, '--merge', '--delete-branch']);
    merged++;
    console.log(`MERGED #${pr.number} ${pr.title}`);
  } catch (err) {
    failed++;
    console.error(`FAIL   #${pr.number} ${pr.title}: ${err.message}`);
  }
}

console.log(`\nDone. merged=${merged} skipped=${skipped} failed=${failed}${DRY_RUN ? ' (dry-run)' : ''}.`);
process.exit(failed > 0 ? 1 : 0);
