import assert from "node:assert/strict";
import test from "node:test";

import {
  blockingCheckState,
  isNonBlockingCheck,
  labelNames,
  mergeGateFailures,
  mergePullRequestArgs,
  reviewedHeadMatches,
  reviewedSha,
  selectDeveloperPrAction,
  selectReviewQueue,
  workflowPullRequests
} from "./delivery-workflow.mjs";

const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const otherSha = "1234567890abcdef1234567890abcdef12345678";
const passingCheck = {
  __typename: "CheckRun",
  name: "Quality",
  status: "COMPLETED",
  conclusion: "SUCCESS"
};

function pullRequest(overrides = {}) {
  return {
    number: 10,
    createdAt: "2026-07-21T00:00:00Z",
    headRefName: "dev/issue-9-example",
    headRefOid: headSha,
    labels: [],
    comments: [],
    closingIssuesReferences: [{ number: 9 }],
    statusCheckRollup: [passingCheck],
    ...overrides
  };
}

test("blocking checks classify modern, legacy, missing, and non-blocking states", () => {
  assert.deepEqual(labelNames({}), []);
  assert.deepEqual(labelNames({ labels: [{ name: "ready" }] }), ["ready"]);
  assert.equal(isNonBlockingCheck({ name: "Lighthouse (non-blocking)" }), true);
  assert.equal(isNonBlockingCheck({ context: "advisory non-blocking" }), true);
  assert.equal(isNonBlockingCheck({}), false);
  assert.deepEqual(blockingCheckState(), { status: "missing", failures: [] });
  assert.deepEqual(
    blockingCheckState([{ ...passingCheck, name: "advisory non-blocking", conclusion: "FAILURE" }]),
    { status: "missing", failures: [] }
  );

  const failures = blockingCheckState([
    { __typename: "StatusContext", context: "legacy-ok", state: "SUCCESS" },
    { __typename: "StatusContext", context: "legacy-wait", state: "PENDING" },
    { __typename: "StatusContext", context: "legacy-expected", state: "EXPECTED" },
    { __typename: "StatusContext", context: "legacy-bad", state: "ERROR" },
    { ...passingCheck, status: "IN_PROGRESS", conclusion: null },
    passingCheck,
    { ...passingCheck, name: "neutral", conclusion: "NEUTRAL" },
    { ...passingCheck, name: "skipped", conclusion: "SKIPPED" },
    { ...passingCheck, name: "broken", conclusion: "FAILURE" }
  ]);
  assert.deepEqual(failures, {
    status: "failed",
    failures: ['status "legacy-bad" is ERROR', 'check "broken" is FAILURE']
  });
  assert.deepEqual(blockingCheckState([{ ...passingCheck, status: "QUEUED", conclusion: null }]), {
    status: "pending",
    failures: []
  });
  assert.deepEqual(blockingCheckState([passingCheck]), {
    status: "passing",
    failures: []
  });
});

test("review markers require the complete exact head SHA", () => {
  assert.equal(reviewedSha(), null);
  assert.equal(
    reviewedSha([
      {},
      { body: "reviewer-run-reviewed: abcdef1" },
      { body: `reviewer-run-reviewed: ${headSha.toUpperCase()}` },
      { body: `old ${headSha} reviewer-run-reviewed: ${otherSha}` }
    ]),
    otherSha
  );
  assert.equal(
    reviewedHeadMatches(
      pullRequest({
        comments: [{ body: `reviewer-run-reviewed: ${headSha.toUpperCase()}` }]
      })
    ),
    true
  );
  assert.equal(
    reviewedHeadMatches(pullRequest({ comments: [{ body: "reviewer-run-reviewed: abcdef1" }] })),
    false
  );
  assert.equal(
    reviewedHeadMatches(
      pullRequest({
        headRefOid: undefined,
        comments: [{ body: `reviewer-run-reviewed: ${headSha}` }]
      })
    ),
    false
  );
});

test("workflow ownership and developer action preserve WIP ordering", () => {
  const workflow = workflowPullRequests([
    pullRequest({
      number: 14,
      headRefName: "feature/unrelated",
      labels: [{ name: "needs-review" }],
      closingIssuesReferences: [{ number: 10 }]
    }),
    pullRequest({
      number: 13,
      headRefName: "dev/no-linked-issue",
      labels: undefined,
      closingIssuesReferences: []
    }),
    pullRequest({
      number: 15,
      headRefName: undefined,
      labels: [{ name: "needs-review" }],
      closingIssuesReferences: [{ number: 11 }]
    }),
    pullRequest({
      number: 12,
      headRefName: "feature/unrelated",
      labels: []
    }),
    pullRequest({
      number: 11,
      headRefName: "dev/issue-10-second",
      closingIssuesReferences: [{ number: 10 }]
    })
  ]);
  assert.deepEqual(
    workflow.map((item) => [item.number, item.issue]),
    [
      [11, 10],
      [14, 10],
      [15, 11],
      [13, Infinity]
    ]
  );

  const failed = { ...passingCheck, conclusion: "FAILURE" };
  const pending = { ...passingCheck, status: "IN_PROGRESS", conclusion: null };
  assert.equal(
    selectDeveloperPrAction([
      pullRequest({ labels: [{ name: "changes-requested" }], statusCheckRollup: [failed] })
    ]).action,
    "fix"
  );
  assert.equal(
    selectDeveloperPrAction([pullRequest({ statusCheckRollup: [failed] })]).action,
    "fix-ci"
  );
  assert.equal(
    selectDeveloperPrAction([pullRequest({ statusCheckRollup: [pending] })]).action,
    "wait"
  );
  assert.equal(
    selectDeveloperPrAction([
      pullRequest({
        isDraft: true,
        statusCheckRollup: [failed]
      })
    ]).action,
    "wait"
  );
  assert.equal(
    selectDeveloperPrAction([
      pullRequest({
        labels: [{ name: "blocked" }],
        statusCheckRollup: [failed]
      })
    ]).action,
    "wait"
  );
  assert.deepEqual(selectDeveloperPrAction([]), { action: "none", open: [] });
});

test("review queue skips blocked work and recovers stale approvals deterministically", () => {
  const queue = selectReviewQueue([
    pullRequest({
      number: 16,
      createdAt: "2026-07-21T02:00:00Z",
      labels: [{ name: "review-approved" }],
      comments: [{ body: `reviewer-run-reviewed: ${otherSha}` }]
    }),
    pullRequest({
      number: 15,
      createdAt: "2026-07-21T01:00:00Z",
      labels: [{ name: "needs-review" }]
    }),
    pullRequest({
      number: 14,
      createdAt: "2026-07-21T01:00:00Z",
      labels: [{ name: "needs-review" }]
    }),
    pullRequest({
      number: 13,
      isDraft: true,
      labels: [{ name: "needs-review" }]
    }),
    pullRequest({
      number: 12,
      labels: [{ name: "needs-review" }, { name: "blocked" }]
    }),
    pullRequest({
      number: 11,
      labels: [{ name: "changes-requested" }]
    }),
    pullRequest({
      labels: [{ name: "review-approved" }],
      comments: [{ body: `reviewer-run-reviewed: ${headSha}` }]
    }),
    pullRequest({ labels: [] })
  ]);

  assert.deepEqual(
    queue.map((item) => item.number),
    [14, 15, 16]
  );
});

test("merge gate requires exact approval, complete checks, and an atomic head match", () => {
  const base = pullRequest({
    state: "OPEN",
    isDraft: false,
    labels: [{ name: "review-approved" }],
    comments: [{ body: `reviewer-run-reviewed: ${headSha}` }],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN"
  });
  assert.deepEqual(mergeGateFailures(base), []);
  assert.deepEqual(mergeGateFailures({ ...base, mergeStateStatus: "UNSTABLE" }), []);
  assert.deepEqual(mergePullRequestArgs(base, "owner/repo"), [
    "pr",
    "merge",
    "10",
    "--repo",
    "owner/repo",
    "--merge",
    "--delete-branch",
    "--match-head-commit",
    headSha
  ]);

  const invalid = mergeGateFailures({
    ...base,
    state: "CLOSED",
    isDraft: true,
    labels: [{ name: "blocked" }, { name: "needs-review" }, { name: "changes-requested" }],
    comments: [],
    statusCheckRollup: [],
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    closingIssuesReferences: undefined
  });
  assert.ok(invalid.includes("state is CLOSED"));
  assert.ok(invalid.includes("PR is a draft"));
  assert.ok(invalid.includes("has blocked label"));
  assert.ok(invalid.includes("missing review-approved label"));
  assert.ok(invalid.includes("has needs-review label"));
  assert.ok(invalid.includes("has changes-requested label"));
  assert.ok(invalid.includes("no reviewer-run-reviewed marker"));
  assert.ok(invalid.includes("no required checks reported"));
  assert.ok(invalid.includes("mergeable is CONFLICTING"));
  assert.ok(invalid.includes("merge state is DIRTY"));
  assert.ok(invalid.includes("no linked closing issue"));

  const stale = mergeGateFailures({
    ...base,
    comments: [{ body: `reviewer-run-reviewed: ${otherSha}` }],
    statusCheckRollup: [{ ...passingCheck, conclusion: "FAILURE" }]
  });
  assert.ok(stale.some((reason) => reason.includes("!= reviewed")));
  assert.ok(stale.some((reason) => reason.includes("FAILURE")));

  assert.ok(
    mergeGateFailures({
      ...base,
      headRefOid: undefined
    }).some((reason) => reason.includes("head  != reviewed"))
  );

  assert.ok(
    mergeGateFailures({
      ...base,
      statusCheckRollup: [{ ...passingCheck, status: "QUEUED", conclusion: null }]
    }).includes("required checks are pending")
  );
});
