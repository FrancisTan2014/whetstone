// Golden fixture tests for the deterministic coordinator routing (decide()).
// Run: node scripts/coordinator-tick.test.mjs
//
// Each case crafts a status + lock state and asserts the routing action/reason.
// These are the deterministic guarantees behind the workflow's reliability.

import assert from 'node:assert/strict';
import { decide } from './coordinator-tick.mjs';

const NOW = new Date('2026-06-23T10:00:00.000Z');
const future = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
const past = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();

const noLocks = { worker: false, developerClaim: false, reviewerWork: false };

function baseStatus(overrides = {}) {
  return {
    coordinator: { paused: false },
    developer: {
      state: 'idle', currentIssue: null, currentPr: null, branch: null,
      worktree: null, failureCount: 0, nextRetryAfter: null
    },
    reviewer: { nextRetryAfter: null },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [] },
    ...overrides
  };
}

const issue = (number, labels, body = '') => ({ number, labels, body });
const pr = (number, labels, headRefName = '') => ({ number, labels, headRefName });

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// 1. paused
test('paused short-circuits', () => {
  const s = baseStatus({ coordinator: { paused: true } });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'paused');
});

// 2. abandon after 3 failures, no PR
test('abandon after 3 developer failures with no PR', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: null, failureCount: 3, nextRetryAfter: null }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'abandon');
  assert.equal(d.reason, 'abandon_developer_issue_3');
});

test('no abandon when a PR exists even at 3 failures', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: 11, failureCount: 3, branch: 'dev/issue-3', worktree: 'w' }
  });
  const d = decide(s, noLocks, NOW);
  assert.notEqual(d.action, 'abandon');
});

// 3/4. busy locks
test('active worker lock means busy', () => {
  const d = decide(baseStatus(), { ...noLocks, worker: true }, NOW);
  assert.equal(d.action, 'worker_busy');
});
test('non-stale developer-claim lock means busy', () => {
  const d = decide(baseStatus(), { ...noLocks, developerClaim: true }, NOW);
  assert.equal(d.action, 'worker_busy');
});
test('non-stale reviewer-work lock means busy', () => {
  const d = decide(baseStatus(), { ...noLocks, reviewerWork: true }, NOW);
  assert.equal(d.action, 'worker_busy');
});

// 5. resume unfinished developer work
test('resume failed developer work (retry due)', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: null, branch: 'dev/issue-3', worktree: 'w', nextRetryAfter: past }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_developer');
  assert.equal(d.reason, 'resume_developer_recovery');
});

test('failed developer work in backoff waits', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: null, branch: 'dev/issue-3', worktree: 'w', nextRetryAfter: future }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'developer_backoff');
});

test('implementing state with no worker is marked failed and retried', () => {
  const s = baseStatus({
    developer: { state: 'implementing', currentIssue: 3, currentPr: null, branch: 'dev/issue-3', worktree: 'w', nextRetryAfter: null }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_developer');
  assert.equal(d.patch.developer.state, 'failed');
  assert.equal(d.patch.developer.resumeReason, 'worker_missing_after_incomplete_run');
});

// 6. changes-requested PR -> developer
test('changes-requested PR routes to developer', () => {
  const s = baseStatus({ remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [pr(11, ['changes-requested'])] } });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_developer');
  assert.equal(d.reason, 'developer_changes_requested_pr_11');
});

test('changes-requested PR in developer backoff waits', () => {
  const s = baseStatus({
    developer: { state: 'idle', currentIssue: null, currentPr: null, failureCount: 0, nextRetryAfter: future },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [pr(11, ['changes-requested'])] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'developer_backoff');
});

// 7. needs-review / review-approved -> reviewer
test('needs-review PR routes to reviewer', () => {
  const s = baseStatus({ remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [pr(11, ['needs-review'])] } });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_reviewer');
});

test('review-approved PR routes to reviewer (merge-gate)', () => {
  const s = baseStatus({ remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [pr(11, ['review-approved'])] } });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_reviewer');
});

test('reviewer backoff waits', () => {
  const s = baseStatus({
    reviewer: { nextRetryAfter: future },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [pr(11, ['needs-review'])] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'reviewer_backoff');
});

test('changes-requested takes priority over needs-review', () => {
  const s = baseStatus({
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [pr(12, ['needs-review']), pr(11, ['changes-requested'])] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_developer');
});

// 8-12. ready issues, dependency ordering
test('lowest-numbered dependency-ready issue is chosen', () => {
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(5, ['ready-for-dev'], 'Depends on: #4'), issue(4, ['ready-for-dev'], '')],
      pullRequests: []
    }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_developer');
  assert.equal(d.reason, 'developer_new_issue_4');
});

test('issue with an open dependency is skipped', () => {
  // #4 depends on #3 which is still open -> only nothing is ready
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(4, ['ready-for-dev'], 'Depends on: #3'), issue(3, ['ready-for-dev'], 'Depends on: #99')],
      pullRequests: []
    }
  });
  // #3 depends on #99 (closed: not in open set) so #3 is ready and lowest
  const d = decide(s, noLocks, NOW);
  assert.equal(d.reason, 'developer_new_issue_3');
});

test('in-progress issue with no PR is resumed (orphan recovery)', () => {
  // A claim labelled in-progress with no PR and no live worker is an orphan: resume it
  // (anchored on the GitHub label, even when the local snapshot has no record).
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(3, ['in-progress'], '')],
      pullRequests: []
    }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_developer');
  assert.equal(d.reason, 'developer_resume_in_progress_issue_3');
});

test('orphaned in-progress yields to a live worker', () => {
  const s = baseStatus({
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [issue(3, ['in-progress'], '')], pullRequests: [] }
  });
  const d = decide(s, { ...noLocks, worker: true }, NOW);
  assert.equal(d.action, 'worker_busy');
});

test('lowest-numbered orphaned in-progress issue is chosen', () => {
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(12, ['in-progress'], ''), issue(11, ['in-progress'], '')],
      pullRequests: []
    }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.reason, 'developer_resume_in_progress_issue_11');
});

test('in-progress issue with its own open PR is not orphan-resumed', () => {
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(11, ['in-progress'], '')],
      pullRequests: [pr(20, [], 'dev/issue-11-admin-author-work')]
    }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'idle');
});

test('needs-review PR for an in-progress issue still routes to reviewer', () => {
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(11, ['in-progress'], '')],
      pullRequests: [pr(20, ['needs-review'], 'dev/issue-11-admin-author-work')]
    }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_reviewer');
});

test('orphaned in-progress respects developer backoff', () => {
  const s = baseStatus({
    developer: { state: 'idle', currentIssue: null, currentPr: null, failureCount: 0, nextRetryAfter: future },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [issue(11, ['in-progress'], '')], pullRequests: [] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'developer_backoff');
});

test('recorded unfinished local work beats orphan-label resume', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: null, branch: 'dev/issue-3', worktree: 'w', nextRetryAfter: past },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [issue(11, ['in-progress'], '')], pullRequests: [] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.reason, 'resume_developer_recovery');
});

test('issue whose dependency is still open yields idle', () => {
  // #3 is blocked (not ready, not in-progress) and still open, so #4's dependency is
  // unmet and nothing is dispatchable.
  const s = baseStatus({
    remote: {
      lastSyncCompletedAt: NOW.toISOString(),
      issues: [issue(4, ['ready-for-dev'], 'Depends on: #3'), issue(3, ['blocked'], '')],
      pullRequests: []
    }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'idle');
});

test('new-issue in developer backoff waits', () => {
  const s = baseStatus({
    developer: { state: 'idle', currentIssue: null, currentPr: null, failureCount: 0, nextRetryAfter: future },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [issue(3, ['ready-for-dev'], '')], pullRequests: [] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'developer_backoff');
});

// 13. idle
test('no work yields idle', () => {
  const d = decide(baseStatus(), noLocks, NOW);
  assert.equal(d.action, 'idle');
});

// priority: resume unfinished work before claiming a brand-new issue
test('unfinished work beats a ready new issue', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: null, branch: 'dev/issue-3', worktree: 'w', nextRetryAfter: past },
    remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [issue(4, ['ready-for-dev'], '')], pullRequests: [] }
  });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.reason, 'resume_developer_recovery');
});

// string labels (snapshot may store names directly) are handled
test('string labels are supported', () => {
  const s = baseStatus({ remote: { lastSyncCompletedAt: NOW.toISOString(), issues: [], pullRequests: [{ number: 11, labels: ['needs-review'] }] } });
  const d = decide(s, noLocks, NOW);
  assert.equal(d.action, 'start_reviewer');
});

test('no abandon while a worker is genuinely running', () => {
  const s = baseStatus({
    developer: { state: 'failed', currentIssue: 3, currentPr: null, failureCount: 3, branch: 'dev/issue-3', worktree: 'w', nextRetryAfter: past }
  });
  const d = decide(s, { ...noLocks, worker: true }, NOW);
  assert.equal(d.action, 'worker_busy');
});

let passed = 0;
let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${c.name}`);
    console.error(`  ${err.message}`);
  }
}

console.log(`\ncoordinator-tick tests: ${passed} passed, ${failed} failed (${cases.length} total)`);
process.exit(failed === 0 ? 0 : 1);
