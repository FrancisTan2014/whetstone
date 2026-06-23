// Deterministic whetstone coordinator tick.
//
// This is a faithful, code-based encoding of prompts/coordinator-schedule.txt so the
// scheduling decision is executed, not re-reasoned by an LLM every tick. The routing
// logic lives in the pure `decide()` function so it can be unit-tested with crafted
// inputs (the fixture/golden test set in coordinator-tick.test.mjs).
//
// Usage:
//   node scripts/coordinator-tick.mjs            # real tick: cleanup, sync, decide, invoke
//   node scripts/coordinator-tick.mjs --dry-run  # pure decision only: no cleanup/sync/invoke/write
//   node scripts/coordinator-tick.mjs --no-invoke # do everything except launch a worker
//   node scripts/coordinator-tick.mjs --no-sync   # skip git fetch + gh snapshot
//
// Environment overrides (used by tests):
//   WHETSTONE_STATUS_PATH  path to the status JSON (defaults to .agent-status.local.json)

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const REPO = 'FrancisTan2014/whetstone';

const STATUS_PATH = process.env.WHETSTONE_STATUS_PATH
  ? path.resolve(process.env.WHETSTONE_STATUS_PATH)
  : path.join(repoRoot, '.agent-status.local.json');
const EXAMPLE_STATUS_PATH = path.join(repoRoot, 'docs', 'agent-status.example.json');
const LOCKS_DIR = path.join(repoRoot, '.agent-locks');

const WORKER_LOCK = path.join(LOCKS_DIR, 'worker.lock');
const DEVELOPER_CLAIM_LOCK = path.join(LOCKS_DIR, 'developer-claim.lock');
const REVIEWER_WORK_LOCK = path.join(LOCKS_DIR, 'reviewer-work.lock');
const STATUS_SYNC_LOCK = path.join(LOCKS_DIR, 'status-sync.lock');

const CLAIM_LOCK_STALE_MS = 30 * 60 * 1000;
const SYNC_LOCK_STALE_MS = 10 * 60 * 1000;
const REMOTE_STALE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure routing decision. Given the current status, lock state, and clock, return
// the action to take plus any status field changes. No side effects.
//
// locks: { worker:boolean, developerClaim:boolean, reviewerWork:boolean }
//   (presence flags AFTER stale locks have been cleaned up by the caller)
// Returns: { action, reason, patch }
//   action in: 'paused' | 'abandon' | 'worker_busy' | 'developer_backoff'
//              | 'reviewer_backoff' | 'start_developer' | 'start_reviewer' | 'idle'
//   patch: shallow field updates to apply to status before persisting
// ---------------------------------------------------------------------------
export function decide(status, locks, now = new Date()) {
  const dev = status.developer ?? {};
  const rev = status.reviewer ?? {};
  const coord = status.coordinator ?? {};
  const issues = status.remote?.issues ?? [];
  const prs = status.remote?.pullRequests ?? [];

  const inFuture = (iso) => iso != null && new Date(iso).getTime() > now.getTime();
  const labelsOf = (item) => (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

  // 2. paused
  if (coord.paused === true) {
    return { action: 'paused', reason: 'paused', patch: {} };
  }

  // 3. abandon after 3 developer failures with no PR — but never while a worker is
  // genuinely running, since abandon removes the worktree out from under it.
  if (
    !locks.worker &&
    (dev.failureCount ?? 0) >= 3 &&
    dev.currentIssue != null &&
    dev.currentPr == null
  ) {
    return { action: 'abandon', reason: `abandon_developer_issue_${dev.currentIssue}`, patch: {} };
  }

  // 4 & 5. an active worker or a non-stale claim/review lock means a worker is busy
  if (locks.worker || locks.developerClaim || locks.reviewerWork) {
    return { action: 'worker_busy', reason: 'worker_busy', patch: {} };
  }

  // 6. recorded unfinished developer work (resume before claiming anything new)
  const devState = dev.state;
  const hasIncompleteRun =
    (devState === 'implementing' || devState === 'in_progress') &&
    (dev.worktree != null || dev.branch != null) &&
    dev.currentPr == null;
  const hasUnfinished = devState === 'failed' || hasIncompleteRun;
  if (hasUnfinished) {
    const patch = { developer: {} };
    let effectiveNextRetry = dev.nextRetryAfter;
    if (hasIncompleteRun) {
      // worker disappeared mid-run: mark failed and schedule an immediate retry
      patch.developer.state = 'failed';
      patch.developer.resumeReason = 'worker_missing_after_incomplete_run';
      patch.developer.lastResult = 'process_incomplete_no_worker';
      patch.developer.lastFailureAt = now.toISOString();
      effectiveNextRetry = dev.nextRetryAfter ?? now.toISOString();
      patch.developer.nextRetryAfter = effectiveNextRetry;
    }
    if (inFuture(effectiveNextRetry)) {
      return { action: 'developer_backoff', reason: 'developer_backoff', patch };
    }
    return { action: 'start_developer', reason: 'resume_developer_recovery', patch };
  }

  // 7. a PR needing fixes goes back to the developer
  const changesRequested = prs.find((pr) => labelsOf(pr).includes('changes-requested'));
  if (changesRequested) {
    if (inFuture(dev.nextRetryAfter)) {
      return { action: 'developer_backoff', reason: 'developer_backoff', patch: {} };
    }
    return {
      action: 'start_developer',
      reason: `developer_changes_requested_pr_${changesRequested.number}`,
      patch: {}
    };
  }

  // 8. a PR awaiting review or merge goes to the reviewer
  const reviewable = prs.find((pr) => {
    const labels = labelsOf(pr);
    return labels.includes('needs-review') || labels.includes('review-approved');
  });
  if (reviewable) {
    if (inFuture(rev.nextRetryAfter)) {
      return { action: 'reviewer_backoff', reason: 'reviewer_backoff', patch: {} };
    }
    return { action: 'start_reviewer', reason: `reviewer_pr_${reviewable.number}`, patch: {} };
  }

  // 9-12. the lowest-numbered dependency-ready ready-for-dev issue
  const openIssueNumbers = new Set(issues.map((i) => i.number));
  const dependencyClosed = (n) => !openIssueNumbers.has(n);
  const dependsOn = (body) => {
    const out = [];
    const re = /Depends on:\s*#(\d+)/gi;
    let m;
    while ((m = re.exec(body ?? '')) !== null) {
      out.push(Number(m[1]));
    }
    return out;
  };

  const candidate = issues
    .filter((i) => {
      const labels = labelsOf(i);
      return labels.includes('ready-for-dev') && !labels.includes('in-progress');
    })
    .filter((i) => dependsOn(i.body).every(dependencyClosed))
    .sort((a, b) => a.number - b.number)[0];

  if (candidate) {
    if (inFuture(dev.nextRetryAfter)) {
      return { action: 'developer_backoff', reason: 'developer_backoff', patch: {} };
    }
    return { action: 'start_developer', reason: `developer_new_issue_${candidate.number}`, patch: {} };
  }

  // 13. nothing to do
  return { action: 'idle', reason: 'idle', patch: {} };
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (only used by main()).
// ---------------------------------------------------------------------------
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.stdio ?? 'pipe',
    shell: false,
    encoding: 'utf8',
    env: process.env
  });
}

function readStatus() {
  if (!existsSync(STATUS_PATH)) {
    if (existsSync(EXAMPLE_STATUS_PATH)) {
      writeFileSync(STATUS_PATH, readFileSync(EXAMPLE_STATUS_PATH));
    } else {
      throw new Error('No status file and no example to seed it from.');
    }
  }
  return JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
}

function writeStatus(status) {
  status.updatedAt = new Date().toISOString();
  writeFileSync(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);
}

function applyPatch(status, patch) {
  for (const [section, fields] of Object.entries(patch ?? {})) {
    status[section] = { ...(status[section] ?? {}), ...fields };
  }
}

function dirAgeMs(dir, now) {
  try {
    return now.getTime() - statSync(dir).mtimeMs;
  } catch {
    return Infinity;
  }
}

function lockState(now) {
  return {
    worker: existsSync(WORKER_LOCK),
    developerClaim: existsSync(DEVELOPER_CLAIM_LOCK) && dirAgeMs(DEVELOPER_CLAIM_LOCK, now) < CLAIM_LOCK_STALE_MS,
    reviewerWork: existsSync(REVIEWER_WORK_LOCK) && dirAgeMs(REVIEWER_WORK_LOCK, now) < CLAIM_LOCK_STALE_MS
  };
}

function snapshotRemote(status, now) {
  const started = now.toISOString();

  // status-sync lock: skip if a fresh sync is already in progress elsewhere
  if (existsSync(STATUS_SYNC_LOCK)) {
    if (dirAgeMs(STATUS_SYNC_LOCK, now) < SYNC_LOCK_STALE_MS) {
      return 'skipped_locked';
    }
    rmSync(STATUS_SYNC_LOCK, { recursive: true, force: true });
  }
  mkdirSync(STATUS_SYNC_LOCK, { recursive: true });

  try {
    run('git', ['fetch', 'origin', '--prune']);

    const issuesRes = run('gh', [
      'issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '200',
      '--json', 'number,title,body,labels,state,url'
    ]);
    const prsRes = run('gh', [
      'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '200',
      '--json', 'number,title,labels,headRefOid,url,isDraft,statusCheckRollup,mergeable,reviewDecision'
    ]);

    const okIssues = issuesRes.status === 0;
    const okPrs = prsRes.status === 0;
    if (okIssues) status.remote.issues = JSON.parse(issuesRes.stdout || '[]');
    if (okPrs) status.remote.pullRequests = JSON.parse(prsRes.stdout || '[]');

    status.remote.lastSyncStartedAt = started;
    status.remote.lastSyncCompletedAt = new Date().toISOString();
    status.remote.lastSyncResult = okIssues && okPrs ? 'success' : 'partial';
    return status.remote.lastSyncResult;
  } finally {
    rmSync(STATUS_SYNC_LOCK, { recursive: true, force: true });
  }
}

function finish(status, reason, dryRun) {
  const now = new Date().toISOString();
  status.coordinator = status.coordinator ?? {};
  status.coordinator.state = 'idle';
  status.coordinator.lastRunCompletedAt = now;
  status.coordinator.lastResult = reason;
  if (!dryRun) writeStatus(status);
  console.log(`coordinator-tick: ${reason}`);
  return reason;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const noSync = dryRun || argv.includes('--no-sync');
  const noInvoke = dryRun || argv.includes('--no-invoke');
  const now = new Date();

  // 1. clear stale worker locks before reading lock state
  if (!dryRun) run('cmd', ['/c', path.join(scriptDir, 'cleanup-agent-locks.cmd')], { stdio: 'ignore' });

  const status = readStatus();
  status.coordinator = status.coordinator ?? {};
  status.coordinator.state = 'running';
  status.coordinator.lastRunStartedAt = now.toISOString();

  // pause short-circuits everything
  if (status.coordinator.paused === true) {
    return finish(status, 'paused', dryRun);
  }

  // 3. abandon a hopeless developer attempt (>=3 failures, no PR)
  const preAbandon = decide(status, lockState(now), now);
  if (preAbandon.action === 'abandon') {
    if (!noInvoke) {
      run('cmd', ['/c', path.join(scriptDir, 'abandon-developer-attempt.cmd')], { stdio: 'inherit' });
    }
    return finish(status, preAbandon.reason, dryRun);
  }

  // remote status sync (coordinator owns this)
  if (!noSync) {
    snapshotRemote(status, now);
  }

  // do not act on a stale snapshot
  const completedAt = status.remote?.lastSyncCompletedAt;
  if (!completedAt || now.getTime() - new Date(completedAt).getTime() > REMOTE_STALE_MS) {
    return finish(status, 'remote_status_stale', dryRun);
  }

  // route
  const decision = decide(status, lockState(now), now);
  applyPatch(status, decision.patch);

  if (!noInvoke) {
    if (decision.action === 'start_developer') {
      run('cmd', ['/c', path.join(scriptDir, 'start-developer.cmd')], { stdio: 'inherit' });
    } else if (decision.action === 'start_reviewer') {
      run('cmd', ['/c', path.join(scriptDir, 'start-reviewer.cmd')], { stdio: 'inherit' });
    }
  }

  return finish(status, decision.reason, dryRun);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
