# Local agent workflow

This repository uses local Copilot CLI runs instead of GitHub Copilot cloud automation.

The stable model is **fresh session per unit of work**, not one permanent session:

1. **Design session**: the user provides product ideas; the design agent turns stable requirements into GitHub issues.
2. **Developer scheduled run**: an external scheduler starts a fresh Copilot CLI process, which claims at most one `ready-for-dev` issue, creates an isolated worktree, implements, tests, pushes, opens a PR, then exits.
3. **Reviewer scheduled run**: an external scheduler starts a fresh Copilot CLI process, which reviews at most one open PR, comments, then exits.
4. **Merge**: merge only after implementation and review are satisfactory.

No helper scripts are required. Each Copilot CLI session can use the same repository, shell, Git, and GitHub CLI capabilities.

Do not use long-lived `/every` watcher sessions for implementation/review. Their context grows over time. Use `copilot -p "..."` from Windows Task Scheduler or another approved external scheduler instead; programmatic Copilot CLI runs the prompt and exits when done.

Scheduled developer/reviewer runs use Copilot CLI's `--allow-all` mode by user preference. Keep each scheduled task's **Start in** directory set to `Q:\src\whetstone` so the agent starts from the intended repository context.

## Labels

- `ready-for-dev`: design is stable and a developer run may claim it.
- `in-progress`: a developer run has claimed it.
- `needs-design`: blocked on requirements/design clarification.
- `needs-review`: implementation is ready for reviewer attention.
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

Design output is a GitHub issue with:

- outcome
- acceptance criteria
- constraints / non-goals
- validation expectations

Apply `ready-for-dev` only when the issue is implementable without guessing.

## Developer scheduled run

Manual one-shot run:

```powershell
cd Q:\src\whetstone
copilot --agent=whetstone-developer -p "Run the developer one-shot workflow in docs/LOCAL_AGENT_WORKFLOW.md. Process at most one ready issue, then stop." --no-ask-user --allow-all
```

External scheduler shape:

- **Program:** `copilot`
- **Start in:** `Q:\src\whetstone`
- **Arguments:**

```text
--agent=whetstone-developer -p "Run the developer one-shot workflow in docs/LOCAL_AGENT_WORKFLOW.md. Process at most one ready issue, then stop." --no-ask-user --allow-all
```

Set the scheduler to avoid overlapping instances. If a previous developer run is still active, skip the next tick.

### Developer one-shot workflow

Goal: find one open issue in `FrancisTan2014/whetstone` labeled `ready-for-dev` and not labeled `in-progress`. If none exists, stay idle and stop.

When an issue is found:

1. Read the full issue and confirm it has outcome, acceptance criteria, constraints/non-goals, and validation.
2. If the issue is ambiguous, add label `needs-design`, remove `ready-for-dev`, comment with the missing decisions, and stop.
3. Claim it by adding `in-progress`, removing `ready-for-dev`, and commenting that it is claimed by the local developer run.
4. Create an isolated git worktree under `Q:\src\whetstone-worktrees\issue-<number>-<short-slug>` from `origin/main`, on branch `dev/issue-<number>-<short-slug>`.
5. Work only in that worktree.
6. Implement only the issue scope.
7. Run the repository's existing validation commands. If none exist yet, state that clearly.
8. Commit with a conventional commit message, push the branch, and open a PR with `Closes #<issue-number>`.
9. Add label `needs-review` to the PR if possible.
10. Do not merge.

You can schedule multiple developer runs, but each run must create its own issue worktree and claim only one issue at a time.

## Reviewer scheduled run

Manual one-shot run:

```powershell
cd Q:\src\whetstone
copilot --agent=whetstone-reviewer -p "Run the reviewer one-shot workflow in docs/LOCAL_AGENT_WORKFLOW.md. Review at most one PR, then stop." --no-ask-user --allow-all
```

External scheduler shape:

- **Program:** `copilot`
- **Start in:** `Q:\src\whetstone`
- **Arguments:**

```text
--agent=whetstone-reviewer -p "Run the reviewer one-shot workflow in docs/LOCAL_AGENT_WORKFLOW.md. Review at most one PR, then stop." --no-ask-user --allow-all
```

Set the scheduler to avoid overlapping instances. If a previous reviewer run is still active, skip the next tick.

### Reviewer one-shot workflow

Goal: find one open non-draft PR in `FrancisTan2014/whetstone` that needs review. Prefer PRs labeled `needs-review`.

Avoid duplicate reviews:

- Get the PR head SHA.
- Skip the PR if it already has a reviewer-run comment or review marker for that same head SHA.
- Re-review if the PR head SHA changed since the last reviewer-run marker.

When a PR needs review:

1. Read the linked issue, PR description, diff, and validation notes.
2. Check correctness, acceptance-criteria fit, scope control, tests/validation, and security-sensitive mistakes.
3. Do not edit files.
4. Leave a GitHub PR review with only material findings.
5. If changes are needed, request changes or leave clear blocking comments, and include marker `reviewer-run-reviewed: <head-sha>`.
6. If ready, leave a concise approval-style comment saying it is ready for human merge, and include marker `reviewer-run-reviewed: <head-sha>`.
7. Do not merge.

Merged PRs are ignored because the reviewer only scans open PRs. Closed issues are ignored because the developer only scans open `ready-for-dev` issues.

## Operating rule

The user only needs to provide product ideas. The design session turns stable ideas into issues; scheduled developer and reviewer runs handle coding and review in fresh, bounded sessions.
