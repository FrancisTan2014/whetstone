import assert from "node:assert/strict";
import test from "node:test";

import {
  blockingCheckState,
  mergeGateFailures,
  selectDeveloperPrAction,
  selectReviewQueue
} from "./delivery-workflow.mjs";

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
    headRefOid: "abcdef1234567890",
    labels: [],
    comments: [],
    closingIssuesReferences: [{ number: 9 }],
    statusCheckRollup: [passingCheck],
    ...overrides
  };
}

test("developer precedence is review feedback, failed CI, then wait", () => {
  const failed = {
    __typename: "CheckRun",
    name: "Quality",
    status: "COMPLETED",
    conclusion: "FAILURE"
  };
  const pending = {
    __typename: "CheckRun",
    name: "Quality",
    status: "IN_PROGRESS",
    conclusion: null
  };

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
        labels: [{ name: "blocked" }],
        statusCheckRollup: [failed]
      })
    ]).action,
    "wait"
  );
});

test("neutral, skipped, and explicitly non-blocking failures never trigger repair", () => {
  const state = blockingCheckState([
    { ...passingCheck, conclusion: "NEUTRAL" },
    { ...passingCheck, name: "Optional", conclusion: "SKIPPED" },
    {
      ...passingCheck,
      name: "Lighthouse (informational, non-blocking)",
      conclusion: "FAILURE"
    }
  ]);

  assert.deepEqual(state, { status: "passing", failures: [] });
  assert.equal(
    selectDeveloperPrAction([
      pullRequest({
        statusCheckRollup: [
          {
            ...passingCheck,
            name: "Lighthouse (informational, non-blocking)",
            conclusion: "FAILURE"
          }
        ]
      })
    ]).action,
    "wait"
  );
});

test("review queue recovers an approved PR whose marker is stale", () => {
  const queue = selectReviewQueue([
    pullRequest({
      labels: [{ name: "review-approved" }],
      comments: [{ body: "reviewer-run-reviewed: 1111111" }]
    }),
    pullRequest({
      number: 11,
      createdAt: "2026-07-21T01:00:00Z",
      labels: [{ name: "review-approved" }],
      comments: [{ body: "reviewer-run-reviewed: abcdef1" }]
    }),
    pullRequest({
      number: 12,
      labels: [{ name: "needs-review" }, { name: "blocked" }]
    })
  ]);

  assert.deepEqual(
    queue.map((item) => item.number),
    [10]
  );
});

test("merge gate requires the exact reviewed head and every blocking check", () => {
  const base = pullRequest({
    state: "OPEN",
    isDraft: false,
    labels: [{ name: "review-approved" }],
    comments: [{ body: "reviewer-run-reviewed: abcdef1" }],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN"
  });
  assert.deepEqual(mergeGateFailures(base), []);
  assert.ok(
    mergeGateFailures({
      ...base,
      labels: [{ name: "review-approved" }, { name: "blocked" }]
    }).includes("has blocked label")
  );

  const stale = mergeGateFailures({
    ...base,
    headRefOid: "9999999999999999",
    statusCheckRollup: [
      {
        ...passingCheck,
        conclusion: "FAILURE"
      }
    ]
  });
  assert.ok(stale.some((reason) => reason.includes("!= reviewed")));
  assert.ok(stale.some((reason) => reason.includes("FAILURE")));
});
