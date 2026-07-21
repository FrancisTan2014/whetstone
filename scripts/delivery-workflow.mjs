export const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function labelNames(item) {
  return (item.labels ?? []).map((label) => label.name);
}

export function isNonBlockingCheck(check) {
  const label = (check.name ?? check.context ?? "").toLowerCase();
  return label.includes("non-blocking");
}

export function blockingCheckState(rollup) {
  const checks = (rollup ?? []).filter((check) => !isNonBlockingCheck(check));
  if (checks.length === 0) return { status: "missing", failures: [] };

  const failures = [];
  let pending = false;
  for (const check of checks) {
    if (check.__typename === "StatusContext") {
      if (check.state === "SUCCESS") continue;
      if (check.state === "PENDING" || check.state === "EXPECTED") pending = true;
      else failures.push(`status "${check.context}" is ${check.state}`);
      continue;
    }

    if (check.status !== "COMPLETED") {
      pending = true;
    } else if (!PASSING_CHECK_CONCLUSIONS.has(check.conclusion)) {
      failures.push(`check "${check.name}" is ${check.conclusion}`);
    }
  }

  if (failures.length > 0) return { status: "failed", failures };
  return { status: pending ? "pending" : "passing", failures: [] };
}

export function reviewedSha(comments) {
  const marker = /reviewer-run-reviewed:\s*([0-9a-f]{40})(?![0-9a-f])/gi;
  let sha = null;
  for (const comment of comments ?? []) {
    marker.lastIndex = 0;
    let match;
    while ((match = marker.exec(comment.body ?? "")) !== null) sha = match[1];
  }
  return sha;
}

export function reviewedHeadMatches(pullRequest) {
  const marker = reviewedSha(pullRequest.comments);
  if (marker == null) return false;
  const head = (pullRequest.headRefOid ?? "").toLowerCase();
  const reviewed = marker.toLowerCase();
  return head === reviewed;
}

export function mergePullRequestArgs(pullRequest, repo) {
  return [
    "pr",
    "merge",
    String(pullRequest.number),
    "--repo",
    repo,
    "--merge",
    "--delete-branch",
    "--match-head-commit",
    pullRequest.headRefOid
  ];
}

export function workflowPullRequests(pullRequests) {
  const reviewLabels = new Set(["needs-review", "changes-requested", "review-approved"]);
  return pullRequests
    .filter(
      (pullRequest) =>
        (pullRequest.headRefName ?? "").startsWith("dev/") ||
        labelNames(pullRequest).some((name) => reviewLabels.has(name))
    )
    .map((pullRequest) => ({
      ...pullRequest,
      labels: labelNames(pullRequest),
      issue: pullRequest.closingIssuesReferences?.[0]?.number ?? Infinity
    }))
    .sort((left, right) => left.issue - right.issue || left.number - right.number);
}

export function selectDeveloperPrAction(pullRequests) {
  const workflow = workflowPullRequests(pullRequests);
  const actionable = workflow.filter(
    (pullRequest) => !pullRequest.isDraft && !pullRequest.labels.includes("blocked")
  );
  const changesRequested = actionable.find((pullRequest) =>
    pullRequest.labels.includes("changes-requested")
  );
  if (changesRequested != null) {
    return { action: "fix", pr: changesRequested.number, open: workflow };
  }

  const failedChecks = actionable.find(
    (pullRequest) => blockingCheckState(pullRequest.statusCheckRollup).status === "failed"
  );
  if (failedChecks != null) {
    return { action: "fix-ci", pr: failedChecks.number, open: workflow };
  }

  if (workflow.length > 0) {
    return { action: "wait", pr: workflow[0].number, open: workflow };
  }
  return { action: "none", open: [] };
}

export function selectReviewQueue(pullRequests) {
  return pullRequests
    .filter((pullRequest) => !pullRequest.isDraft)
    .filter((pullRequest) => {
      const labels = labelNames(pullRequest);
      if (labels.includes("blocked") || labels.includes("changes-requested")) return false;
      return (
        labels.includes("needs-review") ||
        (labels.includes("review-approved") && !reviewedHeadMatches(pullRequest))
      );
    })
    .sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.number - right.number
    );
}

export function mergeGateFailures(pullRequest) {
  const reasons = [];
  const labels = labelNames(pullRequest);

  if (pullRequest.state !== "OPEN") reasons.push(`state is ${pullRequest.state}`);
  if (pullRequest.isDraft) reasons.push("PR is a draft");
  if (labels.includes("blocked")) reasons.push("has blocked label");
  if (!labels.includes("review-approved")) reasons.push("missing review-approved label");
  if (labels.includes("needs-review")) reasons.push("has needs-review label");
  if (labels.includes("changes-requested")) reasons.push("has changes-requested label");

  const marker = reviewedSha(pullRequest.comments);
  if (marker == null) {
    reasons.push("no reviewer-run-reviewed marker");
  } else if (!reviewedHeadMatches(pullRequest)) {
    reasons.push(
      `head ${(pullRequest.headRefOid ?? "").slice(0, 12)} != reviewed ${marker.slice(0, 12)}`
    );
  }

  const checks = blockingCheckState(pullRequest.statusCheckRollup);
  if (checks.status === "missing") reasons.push("no required checks reported");
  if (checks.status === "pending") reasons.push("required checks are pending");
  reasons.push(...checks.failures);

  if (pullRequest.mergeable !== "MERGEABLE") {
    reasons.push(`mergeable is ${pullRequest.mergeable}`);
  }
  if (pullRequest.mergeStateStatus !== "CLEAN" && pullRequest.mergeStateStatus !== "UNSTABLE") {
    reasons.push(`merge state is ${pullRequest.mergeStateStatus}`);
  }
  if (!pullRequest.closingIssuesReferences?.length) {
    reasons.push("no linked closing issue");
  }

  return reasons;
}
