#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { dependsOn } from "./pick-next-issue.mjs";

const execFileAsync = promisify(execFile);
const maxBuffer = 16 * 1024 * 1024;

async function ghJson(args) {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    maxBuffer
  });
  return JSON.parse(stdout);
}

async function ghApiPages(endpoint) {
  const pages = await ghJson(["api", "--paginate", "--slurp", endpoint]);
  return pages.flat();
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function stats(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    median: percentile(finite, 0.5),
    p90: percentile(finite, 0.9)
  };
}

function labelTimes(events, label, event = "labeled") {
  return events
    .filter((item) => item.event === event && item.label?.name === label)
    .map((item) => Date.parse(item.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function lastAtOrBefore(values, limit) {
  return values.filter((value) => value <= limit).at(-1) ?? null;
}

function minutesBetween(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60_000;
}

export function flowRecord(pr, issueEvents, prEvents, ciRuns = []) {
  const created = Date.parse(pr.createdAt);
  const merged = Date.parse(pr.mergedAt);
  const starts = labelTimes(issueEvents, "in-progress");
  const start = lastAtOrBefore(starts, created) ?? starts[0] ?? null;
  const ready =
    start == null ? null : lastAtOrBefore(labelTimes(issueEvents, "ready-for-dev"), start);
  const approved = lastAtOrBefore(labelTimes(prEvents, "review-approved"), merged);
  const successfulRuns = ciRuns
    .filter((run) => run.conclusion === "success")
    .map((run) => Date.parse(run.updatedAt))
    .filter((time) => Number.isFinite(time) && time >= created && time <= merged)
    .sort((a, b) => a - b);
  const firstGreen = successfulRuns[0] ?? null;
  const finalGreen = successfulRuns.at(-1) ?? null;

  return {
    number: pr.number,
    readyToStartMinutes: minutesBetween(ready, start),
    startToPrMinutes: minutesBetween(start, created),
    prToFirstGreenMinutes: minutesBetween(created, firstGreen),
    firstToFinalGreenMinutes: minutesBetween(firstGreen, finalGreen),
    finalGreenToMergeMinutes: minutesBetween(finalGreen, merged),
    prToMergeMinutes: minutesBetween(created, merged),
    approvalToMergeMinutes: minutesBetween(approved, merged),
    changesRequestedRounds: labelTimes(prEvents, "changes-requested").length,
    changedFiles: pr.changedFiles,
    rawChurn: (pr.additions ?? 0) + (pr.deletions ?? 0)
  };
}

export function summarizeFlow(records) {
  return {
    sample: records.length,
    readyToStartMinutes: stats(records.map((record) => record.readyToStartMinutes)),
    startToPrMinutes: stats(records.map((record) => record.startToPrMinutes)),
    prToFirstGreenMinutes: stats(records.map((record) => record.prToFirstGreenMinutes)),
    firstToFinalGreenMinutes: stats(records.map((record) => record.firstToFinalGreenMinutes)),
    finalGreenToMergeMinutes: stats(records.map((record) => record.finalGreenToMergeMinutes)),
    prToMergeMinutes: stats(records.map((record) => record.prToMergeMinutes)),
    approvalToMergeMinutes: stats(records.map((record) => record.approvalToMergeMinutes)),
    changedFiles: stats(records.map((record) => record.changedFiles)),
    rawChurn: stats(records.map((record) => record.rawChurn)),
    changesRequestedPrs: records.filter((record) => record.changesRequestedRounds > 0).length,
    changesRequestedRounds: records.reduce(
      (total, record) => total + record.changesRequestedRounds,
      0
    ),
    warnedPrs: records.filter((record) => record.changedFiles > 15 || record.rawChurn > 1_500)
      .length
  };
}

export function summarizeQueue(issues, pullRequests) {
  const counts = {
    ready: 0,
    inProgress: 0,
    blocked: 0,
    needsDesign: 0,
    manualGate: 0,
    awaitingReview: 0,
    changesRequested: 0
  };

  for (const issue of issues) {
    const labels = new Set((issue.labels ?? []).map((label) => label.name));
    if (labels.has("ready-for-dev")) counts.ready++;
    if (labels.has("in-progress")) counts.inProgress++;
    if (labels.has("blocked")) counts.blocked++;
    if (labels.has("needs-design")) counts.needsDesign++;
    if (labels.has("manual-gate")) counts.manualGate++;
  }

  for (const pr of pullRequests) {
    const labels = new Set((pr.labels ?? []).map((label) => label.name));
    if (labels.has("needs-review")) counts.awaitingReview++;
    if (labels.has("changes-requested")) counts.changesRequested++;
  }

  const openNumbers = new Set(issues.map((issue) => issue.number));
  const dependencyBlocked = issues.filter((issue) => {
    const labels = new Set((issue.labels ?? []).map((label) => label.name));
    return labels.has("blocked") && dependsOn(issue.body).some((number) => openNumbers.has(number));
  }).length;

  return { ...counts, dependencyBlocked };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function formatDuration(value) {
  if (value == null) return "n/a";
  if (value < 120) return `${value.toFixed(1)}m`;
  return `${(value / 60).toFixed(1)}h`;
}

function formatStats(value, unit = "duration") {
  if (value.count === 0) return "n/a";
  const format = unit === "duration" ? formatDuration : (number) => number.toFixed(1);
  return `${format(value.median)} median / ${format(value.p90)} p90 (n=${value.count})`;
}

function printReport(report) {
  const flow = report.flow;
  const queue = report.queue;
  console.log(`Delivery health: last ${flow.sample} merged workflow PRs`);
  console.log(`  ready -> start:    ${formatStats(flow.readyToStartMinutes)}`);
  console.log(`  start -> PR:       ${formatStats(flow.startToPrMinutes)}`);
  console.log(`  PR -> first green: ${formatStats(flow.prToFirstGreenMinutes)}`);
  console.log(`  green rework:      ${formatStats(flow.firstToFinalGreenMinutes)}`);
  console.log(`  final green -> merge: ${formatStats(flow.finalGreenToMergeMinutes)}`);
  console.log(`  PR -> merge:       ${formatStats(flow.prToMergeMinutes)}`);
  console.log(`  approval -> merge: ${formatStats(flow.approvalToMergeMinutes)}`);
  console.log(`  changed files:     ${formatStats(flow.changedFiles, "number")}`);
  console.log(`  raw line churn:    ${formatStats(flow.rawChurn, "number")}`);
  console.log(
    `  review rework:     ${flow.changesRequestedPrs}/${flow.sample} PRs, ` +
      `${flow.changesRequestedRounds} rounds`
  );
  console.log(`  landability warn:  ${flow.warnedPrs}/${flow.sample} PRs (raw churn signal)`);
  console.log("Current queue");
  console.log(
    `  ready=${queue.ready} in-progress=${queue.inProgress} awaiting-review=${queue.awaitingReview} ` +
      `changes-requested=${queue.changesRequested}`
  );
  console.log(
    `  blocked=${queue.blocked} dependency-blocked=${queue.dependencyBlocked} ` +
      `needs-design=${queue.needsDesign} manual-gate=${queue.manualGate}`
  );
}

function parseArgs(argv) {
  const json = argv.includes("--json");
  const index = argv.indexOf("--limit");
  const rawLimit = index >= 0 ? Number(argv[index + 1]) : 20;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  return { json, limit: rawLimit };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const repo = (await ghJson(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const [pullRequests, issues, openPullRequests, ciRuns] = await Promise.all([
    ghJson([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      String(options.limit),
      "--json",
      "number,title,createdAt,mergedAt,headRefName,additions,deletions,changedFiles,closingIssuesReferences"
    ]),
    ghJson([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "number,title,body,labels"
    ]),
    ghJson([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,labels"
    ]),
    ghJson([
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "ci.yml",
      "--limit",
      String(Math.min(500, options.limit * 5)),
      "--json",
      "displayTitle,headBranch,createdAt,updatedAt,conclusion"
    ])
  ]);

  const records = await mapLimit(pullRequests, 6, async (pr) => {
    const issue = pr.closingIssuesReferences?.[0]?.number;
    const [issueEvents, prEvents] = await Promise.all([
      issue == null
        ? Promise.resolve([])
        : ghApiPages(`repos/${repo}/issues/${issue}/events?per_page=100`),
      ghApiPages(`repos/${repo}/issues/${pr.number}/events?per_page=100`)
    ]);
    const matchingRuns = ciRuns.filter(
      (run) =>
        run.headBranch === pr.headRefName ||
        (run.displayTitle === pr.title &&
          Date.parse(run.createdAt) >= Date.parse(pr.createdAt) &&
          Date.parse(run.createdAt) <= Date.parse(pr.mergedAt))
    );
    return flowRecord(pr, issueEvents, prEvents, matchingRuns);
  });

  const report = {
    repository: repo,
    generatedAt: new Date().toISOString(),
    flow: summarizeFlow(records),
    queue: summarizeQueue(issues, openPullRequests)
  };

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(`delivery-health: ${(error.stderr || error.message).trim()}`);
    console.error(
      "Confirm `gh` is installed, set GH_CONFIG_DIR to the authenticated profile used by this " +
        "repository, run `gh auth status`, then retry from the repository root."
    );
    process.exit(1);
  });
}
