#!/usr/bin/env node
// Deterministic dependency-unblock step for the whetstone reviewer workflow.
//
// The design agent labels a dependency-gated issue `blocked` (not `ready-for-dev`) and names the
// issues it waits on with a `Depends on: #N` line. Once those dependencies are resolved -- their
// PRs merged, so the issues are closed -- the blocked issue should rejoin the developer queue.
// Deciding that must be deterministic, a pure function of the GitHub queue, not a choice left to a
// non-deterministic LLM session -- the same reason merge-approved-prs.mjs decides merges in code.
// The reviewer runs this right AFTER the merge step each tick, so a dependency closed by that
// merge is seen as resolved here; anything missed self-heals on the next run (this scan is
// idempotent and re-evaluates every open `blocked` issue from scratch).
//
// An issue is unblocked iff ALL of:
//   - it is open and labeled `blocked`,
//   - it is NOT labeled `needs-design` (that block is an unresolved decision, not a dependency),
//   - it names at least one `Depends on: #N` dependency, and
//   - every named dependency is no longer open (closed or nonexistent).
// Unblocking removes `blocked`, adds `ready-for-dev`, and posts a short audit comment. The
// dependency parse is shared with the developer's selector (pick-next-issue.mjs) so "dependencies
// resolved" means exactly the same thing on both sides of the handoff.
//
// Usage:
//   node scripts/unblock-ready-issues.mjs            unblock every now-ready blocked issue
//   node scripts/unblock-ready-issues.mjs --dry-run  report what would unblock, change nothing
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-merge.cmd / run-reviewer.cmd).

import { dependsOn, gh, ghJson } from './pick-next-issue.mjs';

const DRY_RUN = process.argv.slice(2).includes('--dry-run');
const BLOCKED_LABEL = 'blocked';
const READY_LABEL = 'ready-for-dev';
const DESIGN_LABEL = 'needs-design';

function labelNames(issue) {
  return (issue.labels ?? []).map((l) => l.name);
}

const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;

const blocked = ghJson([
  'issue', 'list', '--repo', repo, '--state', 'open', '--label', BLOCKED_LABEL,
  '--limit', '500', '--json', 'number,body,labels,title',
]).sort((a, b) => a.number - b.number);

if (blocked.length === 0) {
  console.log('No blocked issues to evaluate.');
  process.exit(0);
}

// One list of every open issue number lets us treat a dependency as satisfied iff it is no longer
// open (closed or nonexistent) -- without one API call per dependency. Mirrors pick-next-issue.mjs.
const openNumbers = new Set(
  ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number'])
    .map((i) => i.number),
);

let unblocked = 0;
let skipped = 0;
let failed = 0;

for (const issue of blocked) {
  const labels = labelNames(issue);
  const deps = dependsOn(issue.body);

  // A block held by an unresolved design decision is not a dependency wait -- leave it.
  if (labels.includes(DESIGN_LABEL)) {
    skipped++;
    console.log(`SKIP    #${issue.number} ${issue.title}`);
    console.log('          - has needs-design (block is an unresolved decision, not a dependency)');
    continue;
  }
  // No named dependency: the block is something other than a dependency wait -- leave it.
  if (deps.length === 0) {
    skipped++;
    console.log(`SKIP    #${issue.number} ${issue.title}`);
    console.log('          - no `Depends on: #N` dependency to resolve');
    continue;
  }
  const stillOpen = deps.filter((n) => openNumbers.has(n));
  if (stillOpen.length > 0) {
    skipped++;
    console.log(`SKIP    #${issue.number} ${issue.title}`);
    console.log(`          - waiting on ${stillOpen.map((n) => `#${n}`).join(', ')}`);
    continue;
  }

  const resolved = deps.map((n) => `#${n}`).join(', ');

  if (DRY_RUN) {
    console.log(`READY   #${issue.number} ${issue.title} (dry-run; deps ${resolved} resolved)`);
    continue;
  }

  try {
    gh([
      'issue', 'edit', String(issue.number), '--repo', repo,
      '--remove-label', BLOCKED_LABEL, '--add-label', READY_LABEL,
    ]);
    gh([
      'issue', 'comment', String(issue.number), '--repo', repo,
      '--body',
      `Dependencies ${resolved} resolved (closed) — unblocking. Removed \`${BLOCKED_LABEL}\`, ` +
        `added \`${READY_LABEL}\`. _(automated reviewer dependency-unblock step)_`,
    ]);
    unblocked++;
    console.log(`UNBLOCK #${issue.number} ${issue.title} (deps ${resolved} resolved)`);
  } catch (err) {
    failed++;
    console.error(`FAIL    #${issue.number} ${issue.title}: ${err.message}`);
  }
}

console.log(
  `\nDone. unblocked=${unblocked} skipped=${skipped} failed=${failed}${DRY_RUN ? ' (dry-run)' : ''}.`,
);
process.exit(failed > 0 ? 1 : 0);
