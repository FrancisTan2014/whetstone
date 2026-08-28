import assert from "node:assert/strict";
import test from "node:test";

import {
  flowRecord,
  percentile,
  summarizeFlow,
  summarizeGateRuns,
  summarizeQueue
} from "./health.mjs";

test("percentile interpolates a sorted sample without mutating it", () => {
  const values = [30, 10, 20];
  assert.equal(percentile(values, 0.5), 20);
  assert.equal(percentile(values, 0.9), 28);
  assert.deepEqual(values, [30, 10, 20]);
  assert.equal(percentile([], 0.5), null);
});

test("flowRecord measures active stages and CI rework", () => {
  const pr = {
    number: 42,
    createdAt: "2026-07-01T11:00:00Z",
    mergedAt: "2026-07-01T12:00:00Z",
    additions: 700,
    deletions: 100,
    changedFiles: 12
  };
  const issueEvents = [
    {
      event: "labeled",
      created_at: "2026-07-01T09:00:00Z",
      label: { name: "ready-for-dev" }
    },
    {
      event: "labeled",
      created_at: "2026-07-01T10:00:00Z",
      label: { name: "in-progress" }
    }
  ];
  const prEvents = [
    {
      event: "labeled",
      created_at: "2026-07-01T11:20:00Z",
      label: { name: "merge-ready" }
    }
  ];
  const ciRuns = [
    { conclusion: "success", updatedAt: "2026-07-01T11:15:00Z" },
    { conclusion: "failure", updatedAt: "2026-07-01T11:30:00Z" },
    { conclusion: "success", updatedAt: "2026-07-01T11:45:00Z" }
  ];

  assert.deepEqual(flowRecord(pr, issueEvents, prEvents, ciRuns), {
    number: 42,
    readyToStartMinutes: 60,
    startToPrMinutes: 60,
    prToFirstGreenMinutes: 15,
    firstToFinalGreenMinutes: 30,
    finalGreenToMergeMinutes: 15,
    prToMergeMinutes: 60,
    mergeReadyToMergeMinutes: 40,
    ciFailureRuns: 1,
    changedFiles: 12,
    rawChurn: 800
  });
});

test("summaries keep missing stage data out of medians", () => {
  const summary = summarizeFlow([
    {
      readyToStartMinutes: null,
      startToPrMinutes: 30,
      prToFirstGreenMinutes: 10,
      firstToFinalGreenMinutes: 0,
      finalGreenToMergeMinutes: 30,
      prToMergeMinutes: 40,
      mergeReadyToMergeMinutes: 2,
      ciFailureRuns: 0,
      changedFiles: 4,
      rawChurn: 100
    },
    {
      readyToStartMinutes: 10,
      startToPrMinutes: 50,
      prToFirstGreenMinutes: 20,
      firstToFinalGreenMinutes: 50,
      finalGreenToMergeMinutes: 10,
      prToMergeMinutes: 80,
      mergeReadyToMergeMinutes: 4,
      ciFailureRuns: 2,
      changedFiles: 20,
      rawChurn: 2_000
    }
  ]);

  assert.deepEqual(summary.readyToStartMinutes, { count: 1, median: 10, p90: 10 });
  assert.equal(summary.startToPrMinutes.median, 40);
  assert.equal(summary.prToFirstGreenMinutes.median, 15);
  assert.equal(summary.firstToFinalGreenMinutes.median, 25);
  assert.equal(summary.finalGreenToMergeMinutes.median, 20);
  assert.equal(summary.ciReworkPrs, 1);
  assert.equal(summary.ciFailureRuns, 2);
  assert.equal(summary.warnedPrs, 1);
});

test("queue summary follows workflow labels and dependency clauses", () => {
  const issues = [
    {
      number: 1,
      body: "",
      labels: [{ name: "ready-for-dev" }]
    },
    {
      number: 2,
      body: "Depends on: #1",
      labels: [{ name: "blocked" }]
    },
    {
      number: 3,
      body: "",
      labels: [{ name: "manual-gate" }]
    }
  ];
  const pullRequests = [
    { labels: [{ name: "merge-ready" }], statusCheckRollup: [] },
    {
      labels: [],
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "Quality",
          status: "COMPLETED",
          conclusion: "FAILURE"
        }
      ]
    }
  ];

  assert.deepEqual(summarizeQueue(issues, pullRequests), {
    ready: 1,
    inProgress: 0,
    blocked: 1,
    needsDesign: 0,
    manualGate: 1,
    mergeReady: 1,
    ciFailed: 1,
    dependencyBlocked: 1
  });
});

test("gate summary separates lane duration and failure class", () => {
  const summary = summarizeGateRuns([
    {
      jobs: [
        {
          name: "Quality (typecheck, lint, 100% coverage)",
          startedAt: "2026-07-21T00:00:00Z",
          completedAt: "2026-07-21T00:08:00Z",
          conclusion: "success"
        },
        {
          name: "Runtime (build, size, smoke, E2E)",
          startedAt: "2026-07-21T00:00:00Z",
          completedAt: "2026-07-21T00:03:00Z",
          conclusion: "failure"
        },
        {
          name: "Isolated contracts",
          startedAt: "2026-07-21T00:00:00Z",
          completedAt: "2026-07-21T00:01:00Z",
          conclusion: "success"
        }
      ]
    }
  ]);

  assert.equal(summary.quality.durationMinutes.median, 8);
  assert.equal(summary.runtime.failures, 1);
  assert.equal(summary.isolated.runs, 1);
});
