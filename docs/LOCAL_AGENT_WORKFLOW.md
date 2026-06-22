# Local agent workflow

This repository uses local Copilot CLI runs instead of GitHub Copilot cloud automation.

The stable model is **visible terminal loop, fresh Copilot session per unit of work**:

1. **Design session**: the user provides product ideas; the design agent turns stable requirements into GitHub issues.
2. **Developer watcher terminal**: a visible terminal loop starts a fresh Copilot CLI coordinator process, which claims at most one `ready-for-dev` issue or `changes-requested` PR, delegates to a subagent when available, pushes/opens/updates a PR, then exits.
3. **Reviewer watcher terminal**: a visible terminal loop starts a fresh Copilot CLI coordinator process, which selects at most one open PR, delegates review to a subagent when available, posts feedback, then exits.
4. **Merge**: merge only after implementation and review are satisfactory.

The `.cmd` files are launchers only. They do not hide work in Windows Task Scheduler; the developer and reviewer watchers run in visible terminals that the user can stop with Ctrl+C.

Do not use long-lived `/every` watcher sessions for implementation/review. Their context grows over time. The watcher `.cmd` files use `copilot -p "..."`, so every cycle starts with fresh context and exits after one unit of work.

Developer/reviewer runs use Copilot CLI's `--allow-all` mode by user preference. The scripts set the working directory to `Q:\src\whetstone` so the agent starts from the intended repository context.

The launchers fetch remote state before starting Copilot:

```text
git fetch origin --prune
```

They also use a simple lock under `%TEMP%` so a new scheduled tick skips if the previous run is still active.

## Labels

- `ready-for-dev`: design is stable and a developer run may claim it.
- `in-progress`: a developer run has claimed it.
- `needs-design`: blocked on requirements/design clarification.
- `needs-review`: implementation is ready for reviewer attention.
- `changes-requested`: reviewer found material feedback; developer run should fix this PR before claiming new issues.
- `review-approved`: reviewer says the PR is ready for human merge.
- `blocked`: blocked by an external dependency or unresolved decision.
- `copilot`: intended for local Copilot agent work.

## Product starting point

Begin from the simplest v0 reading app:

- Admin pages input source reading materials.
- Reader pages display materials.
- Users click or tap words/phrases in the reader to create notes linked to that source text.

Do not reintroduce older complex scope unless a later issue explicitly asks for it.

## Design session

Use the main checkout:

```powershell
cd Q:\src\whetstone
copilot
```

Shortcut:

```powershell
.\scripts\start-design.cmd
```

Design output is a GitHub issue with:

- outcome
- acceptance criteria
- constraints / non-goals
- validation expectations

Apply `ready-for-dev` only when the issue is implementable without guessing.

## Developer watcher

Run once:

```powershell
cd Q:\src\whetstone
.\scripts\start-developer.cmd
```

Run continuously in a visible terminal:

```powershell
cd Q:\src\whetstone
.\scripts\watch-developer.cmd
```

The watcher sleeps 10 minutes between one-shot developer coordinator runs. Press Ctrl+C to stop.

### Developer coordinator workflow

Goal: process at most one unit of developer work, then stop.

Priority order:

1. First handle one open PR labeled `changes-requested`.
2. If none exists, find one open issue in `FrancisTan2014/whetstone` labeled `ready-for-dev` and not labeled `in-progress`.
3. If neither exists, stay idle and stop.

### Developer review-fix workflow

When a PR with `changes-requested` is found:

1. Read the PR, linked issue, acceptance criteria, review comments, failed checks if any, and current head branch.
2. Check out the existing PR branch in its existing worktree if available; otherwise create/update an isolated worktree under `Q:\src\whetstone-worktrees\pr-<number>-fixes` from the PR head branch.
3. Prepare a complete coding-subagent prompt containing PR URL, linked issue, acceptance criteria, review comments, validation expectations, branch name, worktree path, and repository instructions.
4. Start a coding subagent for the fixes when available. The subagent must address only material review feedback and must not add unrelated changes.
5. If subagent delegation is unavailable in the current CLI mode, fix directly, but still process only this one PR.
6. Verify the worktree state and validation summary.
7. Commit with a conventional commit message and push to the existing PR branch.
8. Comment on the PR summarizing how each material review comment was addressed.
9. Remove `changes-requested` and add `needs-review`.
10. Do not merge.

### Developer new-issue workflow

When an issue is found:

1. Read the full issue and confirm it has outcome, acceptance criteria, constraints/non-goals, and validation.
2. If the issue is ambiguous, add label `needs-design`, remove `ready-for-dev`, comment with the missing decisions, and stop.
3. Claim it by adding `in-progress`, removing `ready-for-dev`, and commenting that it is claimed by the local developer run.
4. Create an isolated git worktree under `Q:\src\whetstone-worktrees\issue-<number>-<short-slug>` from `origin/main`, on branch `dev/issue-<number>-<short-slug>`.
5. Prepare a complete coding-subagent prompt containing the issue URL, issue body, acceptance criteria, constraints/non-goals, validation expectations, branch name, worktree path, and repository instructions.
6. Start a coding subagent for implementation when available. The subagent must work only in the issue worktree, implement only the issue scope, run validation, and report what changed.
7. If subagent delegation is unavailable in the current CLI mode, implement directly, but still process only this one issue.
8. Verify the worktree state and validation summary.
9. Commit with a conventional commit message, push the branch, and open a PR with `Closes #<issue-number>`.
10. Add label `needs-review` to the PR if possible.
11. Do not merge.

You can run multiple developer watcher terminals, but each run must create its own issue worktree and claim only one issue at a time.

## Reviewer watcher

Run once:

```powershell
cd Q:\src\whetstone
.\scripts\start-reviewer.cmd
```

Run continuously in a visible terminal:

```powershell
cd Q:\src\whetstone
.\scripts\watch-reviewer.cmd
```

The reviewer watcher waits 5 minutes before its first run, then sleeps 10 minutes between one-shot reviewer coordinator runs. Press Ctrl+C to stop.

### Reviewer coordinator workflow

Goal: find one open non-draft PR in `FrancisTan2014/whetstone` that needs review. Prefer PRs labeled `needs-review`; skip PRs labeled `changes-requested` until a developer run pushes fixes.

Avoid duplicate reviews:

- Get the PR head SHA.
- Skip the PR if it already has a reviewer-run comment or review marker for that same head SHA.
- Re-review if the PR head SHA changed since the last reviewer-run marker.

When a PR needs review:

1. Read the linked issue, PR description, diff, and validation notes.
2. Prepare a complete review-subagent prompt containing the PR URL, linked issue, acceptance criteria, changed files, validation notes, and review priorities.
3. Start a review subagent for detailed analysis when available. The subagent must not edit files.
4. If subagent delegation is unavailable in the current CLI mode, review directly, but still process only this one PR.
5. Leave a GitHub PR review with only material findings.
6. If changes are needed, request changes or leave clear blocking comments, include marker `reviewer-run-reviewed: <head-sha>`, add label `changes-requested`, and remove `needs-review`.
7. If ready, leave a concise approval-style comment saying it is ready for human merge, include marker `reviewer-run-reviewed: <head-sha>`, add label `review-approved`, and remove `needs-review` / `changes-requested`.
8. Do not merge.

Merged PRs are ignored because the reviewer only scans open PRs. Closed issues are ignored because the developer only scans open `ready-for-dev` issues. Review feedback is closed by the `changes-requested` -> developer fix -> `needs-review` loop.

## Operating rule

The user only needs to provide product ideas. The design session turns stable ideas into issues; visible developer and reviewer watcher terminals repeatedly start fresh coordinator runs, delegate implementation/review to subagents when available, and exit after one unit of work.
