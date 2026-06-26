#!/usr/bin/env node
// Deterministic issue selection for the whetstone developer workflow.
//
// The developer agent implements ONE issue per run. Which issue is next must be a pure function of
// the GitHub queue -- not a choice left to a non-deterministic LLM session. `gh issue list`
// returns issues newest-first, so an agent that grabs "the first one" implements the LATEST issue
// instead of the next one in sequence. This script removes that ambiguity: it prints exactly the
// next issue number so run-developer.cmd can hand the agent a concrete `#N` to implement.
//
// Selection order, among open `ready-for-dev` issues whose `Depends on: #N` references are all
// closed (dependency-ready):
//   1. ready `[Bug]`s before ready `[Task]`s -- verified defects are paid down before new feature
//      work (GUIDELINES.md "Functional verification", the closing half of the tester -> developer
//      loop). A bug is an issue labeled `bug` or whose title starts with the `[Bug]` prefix.
//   2. oldest-first (lowest issue number) within each group.
//
// Importable: other workflow scripts import `selectNextIssue()` (and the `gh` helpers) from here.
//
// Usage:
//   node scripts/pick-next-issue.mjs        print the next issue number, or nothing if none is ready
//
// stdout: the chosen issue number and nothing else (so a caller can capture it); empty when none.
// stderr: human-readable diagnostics (the pick, the eligible set, anything blocked by dependencies).
// exit:   0 whether or not a number is printed; 1 only on a `gh`/tooling error.
//
// Requires `gh` on PATH; the caller sets GH_CONFIG_DIR (see run-developer.cmd).

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const READY_LABEL = 'ready-for-dev';

export function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

export function ghJson(args) {
  return JSON.parse(gh(args));
}

// Every #N referenced on a `Depends on:` line, handling "Depends on: #3, #4" and "Depends on #3 and #5".
export function dependsOn(body) {
  const deps = new Set();
  const lineRe = /^[ \t]*depends on\b.*$/gim;
  let line;
  while ((line = lineRe.exec(body ?? '')) !== null) {
    for (const m of line[0].matchAll(/#(\d+)/g)) deps.add(Number(m[1]));
  }
  return [...deps];
}

// An issue is a bug (fixed before feature `[Task]`s) when it carries the `bug` label or its title
// starts with the `[Bug]` prefix. EPUB/issue titles are conventionally prefixed by type.
export function isBug(issue) {
  const labelled = (issue.labels ?? []).some((l) => l.name === 'bug');
  const titled = /^\s*\[bug\]/i.test(issue.title ?? '');
  return labelled || titled;
}

// The next dependency-ready issue: ready `[Bug]`s before ready `[Task]`s, oldest-first within each.
// Returns { next: number|null, eligible: number[], blocked: number[] } with `eligible` in
// selection order (so eligible[0] is the pick).
export function selectNextIssue() {
  const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  const ready = ghJson([
    'issue', 'list', '--repo', repo, '--state', 'open', '--label', READY_LABEL,
    '--limit', '500', '--json', 'number,body,labels,title',
  ]);
  // One list of every open issue number lets us treat a dependency as satisfied iff it is no longer
  // open (closed or nonexistent) -- without one API call per dependency.
  const openNumbers = new Set(
    ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number'])
      .map((i) => i.number),
  );
  const eligibleIssues = ready.filter((i) => dependsOn(i.body).every((n) => !openNumbers.has(n)));
  const byNumber = (a, b) => a.number - b.number;
  // Bug-first, then oldest-first within each group.
  const bugs = eligibleIssues.filter((i) => isBug(i)).sort(byNumber).map((i) => i.number);
  const tasks = eligibleIssues.filter((i) => !isBug(i)).sort(byNumber).map((i) => i.number);
  const eligible = [...bugs, ...tasks];
  const blocked = ready
    .map((i) => i.number)
    .filter((n) => !eligible.includes(n))
    .sort((a, b) => a - b);
  return { next: eligible[0] ?? null, eligible, blocked };
}

function runCli() {
  let result;
  try {
    result = selectNextIssue();
  } catch (err) {
    console.error(`pick-next-issue: failed to query GitHub: ${err.message}`);
    process.exit(1);
  }
  const { next, eligible, blocked } = result;
  if (next == null) {
    console.error(`pick-next-issue: no ${READY_LABEL} issue is dependency-ready.`);
    process.exit(0);
  }
  console.error(
    `pick-next-issue: next=#${next}; eligible=[${eligible.join(', ')}]` +
      (blocked.length ? `; blocked-by-deps=[${blocked.join(', ')}]` : ''),
  );
  console.log(String(next));
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli();
}
