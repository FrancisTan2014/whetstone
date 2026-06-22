import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const statusPath = path.join(repoRoot, '.agent-status.local.json');
const locksDir = path.join(repoRoot, '.agent-locks');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.stdio ?? 'inherit',
    shell: false,
    encoding: 'utf8',
    env: process.env
  });
}

function safeWorktreePath(worktree) {
  if (!worktree) {
    return false;
  }

  const resolved = path.resolve(worktree).toLowerCase();
  const expectedRoot = path.resolve('Q:\\src\\whetstone-worktrees').toLowerCase();
  return resolved.startsWith(expectedRoot + path.sep) || resolved === expectedRoot;
}

if (!existsSync(statusPath)) {
  console.error('No .agent-status.local.json found.');
  process.exit(1);
}

const status = JSON.parse(readFileSync(statusPath, 'utf8'));
const developer = status.developer ?? {};
const coordinator = status.coordinator ?? {};
const issueNumber = developer.currentIssue;
const branch = developer.branch;
const worktree = developer.worktree;

if (!issueNumber) {
  console.log('No developer.currentIssue recorded; nothing to abandon.');
  process.exit(0);
}

if (developer.currentPr) {
  console.error(`Developer currentPr is set (${developer.currentPr}); refusing to abandon work with a PR.`);
  process.exit(1);
}

if (worktree && !safeWorktreePath(worktree)) {
  console.error(`Refusing to remove unsafe worktree path: ${worktree}`);
  process.exit(1);
}

if (worktree && existsSync(worktree)) {
  console.log(`Removing failed developer worktree: ${worktree}`);
  const result = run('git', ['worktree', 'remove', '--force', worktree]);
  if (result.status !== 0) {
    console.warn('git worktree remove failed; falling back to filesystem removal and worktree prune.');
    rmSync(path.toNamespacedPath(worktree), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500
    });

    run('git', ['worktree', 'prune'], { stdio: 'ignore' });

    if (existsSync(worktree)) {
      console.error('Failed to remove worktree via fallback.');
      process.exit(result.status ?? 1);
    }
  }
}

if (branch?.startsWith('dev/issue-')) {
  console.log(`Deleting local failed branch if present: ${branch}`);
  run('git', ['branch', '-D', branch], { stdio: 'ignore' });
} else if (branch) {
  console.error(`Refusing to delete branch with unexpected name: ${branch}`);
  process.exit(1);
}

const retryMarker = '<!-- whetstone-auto-abandon-retry -->';
let priorRetry = false;
const viewResult = run(
  'gh',
  ['issue', 'view', String(issueNumber), '--repo', 'FrancisTan2014/whetstone', '--json', 'comments'],
  { stdio: ['ignore', 'pipe', 'inherit'] }
);
if (viewResult.status === 0 && typeof viewResult.stdout === 'string') {
  try {
    const data = JSON.parse(viewResult.stdout);
    priorRetry =
      Array.isArray(data.comments) &&
      data.comments.some((c) => typeof c.body === 'string' && c.body.includes(retryMarker));
  } catch {
    priorRetry = false;
  }
}

let outcome;
if (priorRetry) {
  console.log(`Issue #${issueNumber} already had one clean retry; parking as blocked.`);
  const editResult = run('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    'FrancisTan2014/whetstone',
    '--remove-label',
    'in-progress',
    '--remove-label',
    'ready-for-dev',
    '--add-label',
    'blocked'
  ]);
  if (editResult.status !== 0) {
    console.error(`Failed to park issue #${issueNumber} as blocked.`);
    process.exit(editResult.status ?? 1);
  }

  const commentResult = run('gh', [
    'issue',
    'comment',
    String(issueNumber),
    '--repo',
    'FrancisTan2014/whetstone',
    '--body',
    'Repeated local developer failures persisted after a clean retry. Parking this issue as `blocked` for human review instead of retrying again. <!-- whetstone-auto-abandon-parked -->'
  ]);
  if (commentResult.status !== 0) {
    console.error(`Failed to comment on issue #${issueNumber}.`);
    process.exit(commentResult.status ?? 1);
  }
  outcome = 'parked_blocked';
} else {
  console.log(`Requeueing issue #${issueNumber} for one clean retry.`);
  const editResult = run('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    'FrancisTan2014/whetstone',
    '--remove-label',
    'in-progress',
    '--add-label',
    'ready-for-dev'
  ]);
  if (editResult.status !== 0) {
    console.error(`Failed to requeue issue #${issueNumber}.`);
    process.exit(editResult.status ?? 1);
  }

  const commentResult = run('gh', [
    'issue',
    'comment',
    String(issueNumber),
    '--repo',
    'FrancisTan2014/whetstone',
    '--body',
    'Abandoned failed local developer attempt after repeated worker failures. Removed the failed worktree and requeued for one clean retry. <!-- whetstone-auto-abandon-retry -->'
  ]);
  if (commentResult.status !== 0) {
    console.error(`Failed to comment on issue #${issueNumber}.`);
    process.exit(commentResult.status ?? 1);
  }
  outcome = 'requeued';
}

const now = new Date().toISOString();
status.developer = {
  ...developer,
  state: 'idle',
  currentIssue: null,
  currentPr: null,
  branch: null,
  worktree: null,
  resumeReason: null,
  lastRunCompletedAt: now,
  lastResult: `${outcome}_issue_${issueNumber}`,
  failureCount: 0,
  lastFailureAt: null,
  nextRetryAfter: null
};

status.coordinator = {
  ...coordinator,
  state: 'idle',
  paused: false,
  pauseReason: null,
  lastResult: `abandoned_developer_attempt_${outcome}_issue_${issueNumber}`
};

status.updatedAt = now;
writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);

for (const lockName of ['worker.lock', 'developer-claim.lock', 'worker-last-failure.json']) {
  const lockPath = path.join(locksDir, lockName);
  if (existsSync(lockPath)) {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

console.log(`Issue #${issueNumber} abandon outcome: ${outcome}.`);
