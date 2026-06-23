# Local agent workflow

Whetstone is built by **manually-triggered** Copilot CLI roles. There is no scheduler, no background
loop, and no shared status file. You (the maintainer) are the coordinator: you decide what runs and
when, and each role does exactly one unit of work and then stops.

## Roles

- **Design** (`whetstone-design`): turns stable ideas into `PRODUCT.md` decisions and
  implementation-ready GitHub issues. Interactive.
- **Developer** (`whetstone-developer`): implements one `ready-for-dev` issue end to end on a clean
  branch and opens one scoped pull request, then stops. Does not merge.
- **Reviewer** (`whetstone-reviewer`): reviews one pull request against `GUIDELINES.md`, posts
  high-signal feedback, and merges only when the merge gates pass, then stops.

The full role definitions live in `.github/agents/*.agent.md`. Shared engineering standards and the
`pnpm validate` gate live in the `whetstone-engineering` skill (`.github/skills/`). `PRODUCT.md` and
`GUIDELINES.md` remain the source of truth.

## How to run

```powershell
cd Q:\src\whetstone
.\scripts\run-design.cmd            # interactive design session
.\scripts\run-developer.cmd 12      # implement issue #12 (omit the number to pick the next ready issue)
.\scripts\run-reviewer.cmd 17       # review PR #17 (omit the number to pick the oldest needs-review PR)
```

Each launcher sets `GH_CONFIG_DIR` to the personal gh config (FrancisTan2014) and runs Copilot in the
foreground with `--allow-all`, so you can watch the run and answer if the role needs a decision.

## Clean-start guarantee

The developer role always branches fresh from `origin/main` and **never resumes a leftover branch or
worktree** from a previous attempt. Abandoned attempts are disposable: if a `dev/issue-<n>-*` branch
exists, the developer deletes and recreates it from `origin/main`, re-deriving everything from the
issue and `PRODUCT.md`. This is what keeps stale or wrong-model work from leaking into a new attempt.

## One unit at a time

The backlog is a dependency chain; issues carry `Depends on: #N`. Run the developer on the lowest
ready issue, then review and merge its PR, then run the developer again. Running more than one
developer session against this repo at the same time corrupts shared git state — trigger one role at
a time.

## Labels

- `ready-for-dev` — design is stable; the developer may implement it.
- `in-progress` — a developer run has claimed it.
- `needs-design` — blocked on a product/requirements decision.
- `needs-review` — a PR is ready for the reviewer.
- `changes-requested` — the reviewer found material feedback; the developer fixes the PR.
- `review-approved` — the PR passed review and can merge once checks are green.
- `blocked` — blocked by an external dependency or unresolved decision.
- `copilot` — intended for local Copilot agent work.
