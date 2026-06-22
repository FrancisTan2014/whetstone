# Local agent workflow

This repository uses local Copilot CLI scheduled prompts instead of GitHub Copilot cloud automation.

The stable model is **one scheduled coordinator plus one local status tracker**:

1. **Design session**: the user provides product ideas; the design agent turns stable requirements into GitHub issues.
2. **Coordinator scheduled session**: Copilot's `/every` prompt wakes up every minute, refreshes GitHub status into `.agent-status.local.json`, decides whether developer or reviewer should run, and invokes at most one one-shot role.
3. **Developer one-shot session**: invoked by the coordinator when local status says development or review-fix work is ready.
4. **Reviewer one-shot session**: invoked by the coordinator when local status says review or merge-gate work is ready.
5. **Merge**: reviewer merges automatically only after implementation, review, and checks are satisfactory.

The local status tracker is `.agent-status.local.json`. It is ignored by Git. If it does not exist, the agents create it from `docs/agent-status.example.json`.

GitHub labels/issues/PRs remain the source of truth. The local tracker is the scheduling snapshot and lease/status log so agents know what they were doing last tick and avoid duplicating work.

All local role sessions use Copilot CLI's `--allow-all` mode by user preference. The scripts set the working directory to `Q:\src\whetstone` so the agent starts from the intended repository context.

The coordinator is responsible for remote status refresh. On each tick it runs:

```text
git fetch origin --prune
```

The scheduled prompt processes at most one unit of work per tick.

Locks live under `.agent-locks/`:

- `status-sync.lock`: coordinator owns remote snapshot refresh.
- `worker.lock`: exactly one developer or reviewer one-shot worker may run at a time. It contains `role.txt`, `pid.txt`, `startedAt.txt`, and `command.txt`.
- `worker-failed.json`: last one-shot worker failed before completing cleanly. Coordinator will stop scheduling new workers until this file is inspected and removed.
- `developer-claim.lock`: developer owns issue/PR selection and claim.
- `reviewer-work.lock`: reviewer owns PR review/merge selection.

Locks are directories so creation is atomic enough for local sessions. If `worker.lock` remains after a PC restart or killed worker process, the coordinator checks the recorded PID and removes the stale lock before scheduling work. Other stale locks may be removed once by the owning prompt as described in `prompts/*.txt`.

## Labels

- `ready-for-dev`: design is stable and a developer run may claim it.
- `in-progress`: a developer run has claimed it.
- `needs-design`: blocked on requirements/design clarification.
- `needs-review`: implementation is ready for reviewer attention.
- `changes-requested`: reviewer found material feedback; developer run should fix this PR before claiming new issues.
- `review-approved`: reviewer says the PR passed review and can be merged once checks are green.
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
.\scripts\start-design.cmd
```

Design output is:

- `PRODUCT.md` updates when decisions stabilize.
- GitHub issues when a slice is implementation-ready.

The design agent must produce scoped issues. Prefer vertical feature/fix issues; do not split one capability into artificial backend/database/frontend issues. Split only unrelated outcomes or broad foundation work.

Each implementation issue includes:

- outcome
- acceptance criteria
- constraints / non-goals
- validation expectations

Apply `ready-for-dev` only when the issue is implementable without guessing.

## Coordinator scheduled session

Start the coordinator scheduled session:

```powershell
cd Q:\src\whetstone
.\scripts\start-coordinator.cmd
```

The launcher opens Copilot with `-i` and automatically submits the `/every 1m` coordinator prompt. No paste step is required.

The coordinator:

1. syncs remote GitHub issue/PR status into `.agent-status.local.json`,
2. checks locks,
3. invokes `scripts\start-developer.cmd` for development/review-fix work, or
4. invokes `scripts\start-reviewer.cmd` for review/merge work.

Developer and reviewer scripts are one-shot. They do not register their own `/every` schedules.
They create `.agent-locks\worker.lock` while running, so the coordinator will not start a second worker before the current one exits.
`start-coordinator.cmd` performs a stale `worker.lock` check before it registers the scheduled coordinator prompt.
If a worker exits nonzero, the launcher writes `.agent-locks\worker-failed.json` and updates `.agent-status.local.json`. The coordinator treats that as a hard stop to avoid silent failure loops.

## Developer one-shot workflow

### Developer coordinator workflow

Goal: process at most one unit of developer work, then stop.

Priority order:

1. First handle one open PR labeled `changes-requested`.
2. If any open PR in local status is labeled `needs-review` or `review-approved`, do not claim a new issue; wait for reviewer review or reviewer merge.
3. If no PR is waiting, find the lowest-numbered open issue in local status labeled `ready-for-dev` and not labeled `in-progress`.
4. If an issue body declares `Depends on: #N`, skip it until every dependency issue is closed.
5. If no dependency-ready issue exists, stay idle and stop.

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
2. If the issue declares dependencies using `Depends on: #N`, verify all dependency issues are closed before claiming.
3. If the issue is ambiguous or dependencies are not closed, add label `needs-design` only for ambiguity; otherwise skip it and stop.
4. Claim it by adding `in-progress`, removing `ready-for-dev`, and commenting that it is claimed by the local developer run.
5. Create an isolated git worktree under `Q:\src\whetstone-worktrees\issue-<number>-<short-slug>` from `origin/main`, on branch `dev/issue-<number>-<short-slug>`.
6. Prepare a complete coding-subagent prompt containing the issue URL, issue body, acceptance criteria, constraints/non-goals, validation expectations, branch name, worktree path, and repository instructions.
7. Start a coding subagent for implementation when available. The subagent must work only in the issue worktree, implement only the issue scope, run validation, and report what changed.
8. If subagent delegation is unavailable in the current CLI mode, implement directly, but still process only this one issue.
9. Verify the worktree state and validation summary.
10. Commit with a conventional commit message, push the branch, and open a PR with `Closes #<issue-number>`.
11. Add label `needs-review` to the PR if possible.
12. Do not merge.

The developer script is one-shot. Run it manually only for debugging; the coordinator normally invokes it.

## Reviewer one-shot workflow

Manual reviewer one-shot:

```powershell
cd Q:\src\whetstone
.\scripts\start-reviewer.cmd
```

Normally the coordinator invokes this script.

### Reviewer coordinator workflow

Goal: process at most one reviewer unit of work from local status. First check open non-draft PRs labeled `review-approved` for merge eligibility. If none are mergeable, find one open non-draft PR that needs review, preferring PRs labeled `needs-review`; skip PRs labeled `changes-requested` until a developer run pushes fixes.

Avoid duplicate reviews:

- Get the PR head SHA.
- Skip the PR if it already has a reviewer-run comment or review marker for that same head SHA, unless the PR is labeled `review-approved` and only needs merge-gate checking.
- Re-review if the PR head SHA changed since the last reviewer-run marker.

When a PR needs review:

1. Read `GUIDELINES.md`, `PRODUCT.md`, the linked issue, PR description, diff, and validation notes.
2. Prepare a complete review-subagent prompt containing the PR URL, linked issue, acceptance criteria, changed files, validation notes, `PRODUCT.md`, and `GUIDELINES.md`.
3. Start a review subagent for detailed analysis when available. The subagent must not edit files.
4. If subagent delegation is unavailable in the current CLI mode, review directly, but still process only this one PR.
5. Leave a GitHub PR review with only material findings.
6. If changes are needed, request changes or leave clear blocking comments, include marker `reviewer-run-reviewed: <head-sha>`, add label `changes-requested`, and remove `needs-review`.
7. If ready, leave a concise approval-style comment, include marker `reviewer-run-reviewed: <head-sha>`, add label `review-approved`, and remove `needs-review` / `changes-requested`.
8. Before merging, verify the PR head SHA still matches the reviewed SHA, checks are green, there are no merge conflicts, and no `changes-requested` / `needs-review` labels remain.
9. If merge gates pass, merge the PR using the repository default merge strategy and delete the branch if safe.
10. If checks are pending/failing or the head SHA changed, do not merge; leave a comment/status and stop for the next tick.

Merged PRs are ignored because the reviewer only scans open PRs. Closed issues are ignored because the developer only scans open `ready-for-dev` issues. Review feedback is closed by the `changes-requested` -> developer fix -> `needs-review` loop.

## Operating rule

The user only needs to provide product ideas. The design session turns stable ideas into issues; the coordinator keeps local status fresh and invokes one-shot developer/reviewer sessions as needed.
