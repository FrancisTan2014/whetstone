import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  blockingCheckState,
  isNonBlockingCheck,
  labelNames,
  mergeGateFailures,
  mergePullRequestArgs,
  REQUIRED_MERGE_CHECK_NAMES,
  requiredMergeCheckFailures,
  selectDeveloperPrAction,
  workflowPullRequests
} from "./workflow.mjs";

const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const passingCheck = {
  __typename: "CheckRun",
  name: "Quality",
  status: "COMPLETED",
  conclusion: "SUCCESS"
};
const requiredPassingChecks = REQUIRED_MERGE_CHECK_NAMES.map((name) => ({
  ...passingCheck,
  name
}));

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

test("required merge checks are named, present, and successful", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const name of REQUIRED_MERGE_CHECK_NAMES) {
    assert.equal(workflow.includes(`name: ${name}`), true);
  }
  assert.deepEqual(requiredMergeCheckFailures(requiredPassingChecks), []);
  assert.deepEqual(requiredMergeCheckFailures(), [
    'required check "Quality (typecheck, lint, 100% coverage)" is missing',
    'required check "Runtime (build, size, smoke, E2E)" is missing',
    'required check "Isolated contracts" is missing',
    'required check "Python worker tests" is missing'
  ]);
  assert.deepEqual(
    requiredMergeCheckFailures([
      {
        __typename: "StatusContext",
        context: "Quality (typecheck, lint, 100% coverage)",
        state: "SUCCESS"
      },
      {
        __typename: "StatusContext",
        context: "Runtime (build, size, smoke, E2E)",
        state: "PENDING"
      },
      {
        ...passingCheck,
        name: "Isolated contracts",
        conclusion: "SKIPPED"
      },
      {
        ...passingCheck,
        name: "Python worker tests"
      }
    ]),
    [
      'required check "Runtime (build, size, smoke, E2E)" is PENDING',
      'required check "Isolated contracts" is SKIPPED'
    ]
  );
  assert.deepEqual(
    requiredMergeCheckFailures([
      requiredPassingChecks[0],
      { ...requiredPassingChecks[1], status: "IN_PROGRESS", conclusion: null },
      requiredPassingChecks[2],
      requiredPassingChecks[3]
    ]),
    ['required check "Runtime (build, size, smoke, E2E)" is IN_PROGRESS']
  );
});

test("quality coverage shards merge under the required gate and propagate failures", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const requiredFragment of [
    "quality-lint:",
    "quality-coverage:",
    "shard: [1, 2, 3, 4]",
    "run: pnpm test:quality:shard --shard=${{ matrix.shard }}/4",
    "uses: actions/upload-artifact@v4",
    "if-no-files-found: error",
    "include-hidden-files: true",
    "needs: [quality-lint, quality-coverage]",
    "if: always()",
    "if: needs.quality-lint.result != 'success' || needs.quality-coverage.result != 'success'",
    "uses: actions/download-artifact@v4",
    "merge-multiple: true",
    "run: pnpm test:quality:merge"
  ]) {
    assert.equal(workflow.includes(requiredFragment), true, `missing ${requiredFragment}`);
  }
});

test("workflow ownership and developer action preserve WIP ordering", () => {
  const workflow = workflowPullRequests([
    pullRequest({
      number: 14,
      headRefName: "feature/unrelated",
      labels: [{ name: "merge-ready" }],
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
      labels: [{ name: "merge-ready" }],
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

test("merge gate requires an explicit ready signal, complete checks, and an atomic head match", () => {
  const base = pullRequest({
    state: "OPEN",
    isDraft: false,
    labels: [{ name: "merge-ready" }],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: requiredPassingChecks
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
    labels: [{ name: "blocked" }, { name: "changes-requested" }],
    statusCheckRollup: [],
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    closingIssuesReferences: undefined
  });
  assert.ok(invalid.includes("state is CLOSED"));
  assert.ok(invalid.includes("PR is a draft"));
  assert.ok(invalid.includes("has blocked label"));
  assert.ok(invalid.includes("missing merge-ready label"));
  assert.ok(invalid.includes("has changes-requested label"));
  assert.ok(invalid.includes("no required checks reported"));
  assert.ok(invalid.includes("mergeable is CONFLICTING"));
  assert.ok(invalid.includes("merge state is DIRTY"));
  assert.ok(invalid.includes("no linked closing issue"));

  const failed = mergeGateFailures({
    ...base,
    statusCheckRollup: [
      { ...requiredPassingChecks[0], conclusion: "FAILURE" },
      requiredPassingChecks[1],
      requiredPassingChecks[2],
      requiredPassingChecks[3]
    ]
  });
  assert.ok(failed.some((reason) => reason.includes("FAILURE")));

  assert.ok(
    mergeGateFailures({
      ...base,
      headRefOid: undefined
    }).includes("missing head commit")
  );

  assert.ok(
    mergeGateFailures({
      ...base,
      statusCheckRollup: [
        requiredPassingChecks[0],
        { ...requiredPassingChecks[1], status: "QUEUED", conclusion: null },
        requiredPassingChecks[2],
        requiredPassingChecks[3]
      ]
    }).includes("required checks are pending")
  );
});
