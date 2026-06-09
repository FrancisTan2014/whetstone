# COWORK.md

Operating manual for whetstone's five-role agent team. This document is how the team actually works in practice: who does what, how work moves between roles, how conflicts resolve, how to start a session.

When this document conflicts with [STABLE.md](./STABLE.md) or [AGENTS.md](./AGENTS.md), those win. This document describes the *operating mode*; the others define the *project itself*.

---

## The five roles

| Role | File | Owns | Reviews | Default model |
|---|---|---|---|---|
| **Architect** | [`.claude/agents/architect.md`](./.claude/agents/architect.md) | [STABLE.md](./STABLE.md), [decisions/](./decisions/), [REVIEW_SPEC.md](./REVIEW_SPEC.md) | PR design correctness AND PR code correctness (per REVIEW_SPEC.md) | Sonnet 4.5 |
| **PM** | [`.claude/agents/pm.md`](./.claude/agents/pm.md) | [DRAFT.md](./DRAFT.md), [BACKLOG.md](./BACKLOG.md), GitHub issues, wiki | PR scope/acceptance alignment | Sonnet 4.5 |
| **Developer** | [`.claude/agents/developer.md`](./.claude/agents/developer.md) | Source code, unit tests | (Implementor, not reviewer; self-review against REVIEW_SPEC.md before opening PR) | Sonnet 4.5 |
| **Tester** | [`.claude/agents/tester.md`](./.claude/agents/tester.md) | [TEST_PLAN.md](./TEST_PLAN.md), bug-report issues | PR user-visible-behavior verification | Sonnet 4.5 |
| **UX designer** | [`.claude/agents/ux-designer.md`](./.claude/agents/ux-designer.md) | [WIREFRAMES.md](./WIREFRAMES.md), UI specs | PR UI/UX fit against wireframes | Sonnet 4.5 |

The human is the **orchestrator** and the **only** authority for: `git push`, `gh pr merge`, editing [AGENTS.md](./AGENTS.md) and this document, modifying [`.claude/approved-deps.txt`](./.claude/approved-deps.txt), and resolving role-level conflicts.

---

## How to start a session

Each role runs in its own terminal. Open five terminals (or as many as you need today). For each:

```bash
cd /q/src/whetstone
claude --agent <role-name>
```

Where `<role-name>` is one of `architect`, `pm`, `developer`, `tester`, `ux-designer`.

The session reads `.claude/agents/<role-name>.md` as its system prompt, applies the permissions and hooks in `.claude/settings.json`, and starts with no prior context.

### What each session reads first

Every role reads, in order: this file ([COWORK.md](./COWORK.md)), [AGENTS.md](./AGENTS.md), [STABLE.md](./STABLE.md), and its own role-specific docs. The role files themselves enforce the read-first order.

### Developer's worktree discipline

The Developer agent runs with `isolation: worktree` — every Developer session starts in a fresh git worktree branched off main. This prevents Developer from stepping on other roles' edits. Other roles run in the main worktree by default; they coordinate via file-edit boundaries (above) rather than git isolation.

---

## File-edit boundaries (the truth source)

Each file in the repo has exactly one role that may edit it. Other roles may read it freely.

| File / directory | Owned by | May edit |
|---|---|---|
| [STABLE.md](./STABLE.md) | Architect | Architect only |
| [decisions/*.md](./decisions/) | Architect | Architect only |
| [REVIEW_SPEC.md](./REVIEW_SPEC.md) | Architect | Architect only (with paired ADR per same-commit rule) |
| [DRAFT.md](./DRAFT.md) | PM | PM only |
| [BACKLOG.md](./BACKLOG.md) | PM | PM only |
| GitHub issues | PM (creator/closer) | PM creates and closes; any role may comment |
| Source code (when it exists) | Developer | Developer only |
| Unit tests (when they exist) | Developer | Developer only |
| [TEST_PLAN.md](./TEST_PLAN.md) | Tester | Tester only |
| [WIREFRAMES.md](./WIREFRAMES.md) | UX designer | UX only |
| UI specs (`ui/screens/*.md` when split) | UX designer | UX only |
| [AGENTS.md](./AGENTS.md) | Human | Human only |
| [COWORK.md](./COWORK.md) | Human | Human only |
| [`.claude/agents/*.md`](./.claude/agents/) | Human | Human only |
| [`.claude/settings.json`](./.claude/settings.json) | Human | Human only |
| [`.claude/hooks/*`](./.claude/hooks/) | Human | Human only |
| [`.claude/approved-deps.txt`](./.claude/approved-deps.txt) | Human | Human only |
| [README.md](./README.md) | Human (with role consultation) | Architect or PM may propose edits via PR |
| [RESEARCH.md](./RESEARCH.md), [AGENT_TEAM_RESEARCH.md](./AGENT_TEAM_RESEARCH.md), [REVIEW_NOTES.md](./REVIEW_NOTES.md) | Frozen reference docs | Append-only; supersede with a new research doc rather than edit |

**The principle**: when a role wants to edit a file it doesn't own, it instead leaves a comment for the owning role — usually on a GitHub issue, sometimes inline in a PR. The owning role considers and decides.

---

## How work moves

### The standard flow

1. **Origin** — a need surfaces. Could come from: the human asking for something, a TODO in DRAFT.md, a bug Tester filed, a wireframe UX completed.
2. **PM scoping** — PM reads the need, decides if it's in v1, drafts an issue with title, "What", "Acceptance criteria", "Convictions touched". If conviction-touching, PM tags `needs-architect-review` and pings Architect (by comment).
3. **Architect review (if tagged)** — Architect comments on the issue: endorse, modify, or reject. If reject, PM either reworks or escalates to human after two iterations.
4. **Developer claim** — Developer reads issues labeled `ready-for-dev`, picks one (assigns to themselves), branches, implements, opens PR. PR description includes `Closes #N`, what changed, why, and a test plan.
5. **Reviews** — three reviewers may comment on the PR, each in their own scope:
   - **Architect**: design fit, conviction alignment, ADR pairing if STABLE.md touched, AND code-level correctness per [REVIEW_SPEC.md](./REVIEW_SPEC.md) (see ADR 0009).
   - **PM**: scope, acceptance criteria, BACKLOG creep.
   - **Tester**: user-visible behavior, regressions, testability.
   - **UX (when UI touched)**: wireframe fit, interaction consistency.
6. **Iteration** — Developer addresses comments, force-pushes the branch, asks for re-review.
7. **Human merge** — when reviewers are satisfied, the human reviews the diff one last time and clicks merge. No agent merges.
8. **Tester verification** — Tester runs the post-merge smoke check (once code exists), files any regressions as new issues.

### Branch naming

- `feat/<short-slug>` for new features.
- `fix/<short-slug>` for bug fixes.
- `docs/<short-slug>` for doc-only changes (these go through fewer reviewers, see below).
- `chore/<short-slug>` for tooling, CI, or housekeeping.

### Doc-only PRs

PRs that touch only `.md` files (no code) skip Tester review. They still get the relevant role review:
- Touches `STABLE.md` / `decisions/` → Architect review.
- Touches `DRAFT.md` / `BACKLOG.md` → PM self-review (the PM authored it; another role may comment).
- Touches `TEST_PLAN.md` → Tester self-review.
- Touches `WIREFRAMES.md` → UX self-review.
- Touches `AGENTS.md` / `COWORK.md` → human-only.

### Pre-implementation phase (where we are today)

Right now there is no code. The flow above adapts:

- **Architect** drafts ADRs (PRs that touch `decisions/` and `STABLE.md` together per same-commit rule).
- **PM** breaks design questions in DRAFT.md into discrete issues; maintains BACKLOG.md.
- **Developer** is mostly idle. May implement the project skeleton when human says so.
- **Tester** drafts TEST_PLAN.md with the v1 test strategy.
- **UX designer** drafts WIREFRAMES.md with v1 screen inventory and flows.

---

## Conflict resolution

Two roles will sometimes disagree. The resolution protocol:

1. **Comment** — the disagreeing role comments on the issue or PR with their position.
2. **One reply** — the originating role responds with their reasoning or revision.
3. **Second comment** — if disagreement persists, the disagreeing role comments again.
4. **One more reply** — originating role replies again.
5. **Escalate** — after two complete iterations without resolution, *either* role comments `needs human judgment` and stops further work on the thread. The human decides.

This caps the loop. No infinite back-and-forth; the human is the tiebreaker.

### Specific conflict patterns to expect

- **Architect rejects a PM-scoped issue** as conviction-violating. PM either reworks the scope or escalates.
- **Architect requests an ADR that PM thinks is overkill.** Escalate after two passes.
- **Tester files a bug for behavior that matches STABLE.md.** Architect or PM responds: "this is by design, see STABLE.md → X." Tester closes the issue.
- **UX designs a UI that Architect flags as conviction-violating** (e.g., a streak counter slipped in). UX revises or escalates.
- **Developer disagrees with Architect's design feedback on a PR.** Two iterations, then human.

---

## What lives off-repo

Some things don't live in the repo and must be done by the human:

- **Setting the Anthropic workspace spend limit.** Currently no hard cap in code; the human sets this in Claude Console. Recommended cap: $200/mo per AGENT_TEAM_RESEARCH.md.
- **`git push`**. Always.
- **`gh pr merge`**. Always.
- **GitHub repo settings** (branch protections, secrets, webhooks).
- **API keys** for any future GitHub Action or Routine. Stored in repo secrets.
- **Personal Anthropic account** for any future Routine or background-mode deployment (the work environment doesn't run autonomous-while-you-sleep work — see "Where the team runs" below).

---

## Where the team runs

The current setup is **interactive Mode B** per AGENT_TEAM_RESEARCH.md: five terminals, all human-driven, all in the work environment with effectively unbounded token access. This is the right starting point.

**Not in scope today** (revisit when Phase 2 of the deployment plan begins):

- **Background agents** (`claude --bg`) running on the local machine without a terminal attached.
- **Routines** — cloud-scheduled or event-triggered sessions (require personal Anthropic plan).
- **GitHub Actions** — `@claude` mention triggers (require Anthropic API key in repo secrets).
- **Agent teams** — Anthropic's experimental multi-agent collaboration mode (cost-prohibitive and fragile per research).

When ready to expand to Phase 2 (autonomous between check-ins), AGENT_TEAM_RESEARCH.md describes the ramp.

---

## Hooks in place

`.claude/settings.json` configures hooks that enforce the most critical hard stops:

- **`git push`** → blocked. Only the human pushes.
- **`gh pr merge`** → blocked at the permissions layer. Only the human merges.
- **`dotnet add package`, `npm install`, etc.** → blocked unless the package name is in `.claude/approved-deps.txt`. Adding to the allowlist is a human-only action.
- **`--no-verify` / `--no-gpg-sign`** → blocked. Pre-commit hooks exist to be respected.
- **Destructive git** (`reset --hard`, `clean -f`, `push --force`) → blocked.

Hooks supplement role rules; they do not replace them. A role that wants to do something blocked should comment to the human and stop.

---

## When to update this document

Update [COWORK.md](./COWORK.md) when:

- The team adds, removes, or merges a role.
- The file-edit boundaries change.
- The flow changes (e.g., a new review step, a new branch convention).
- Phase 2 (autonomous deployment) begins — the "Where the team runs" section gets updated.

Updates to this document are human-only (per the boundaries table). Agents may propose changes via comment in DRAFT.md or via PR comment; the human edits.

---

## Cross-references

- [AGENTS.md](./AGENTS.md) — repo-level rules (apply to all roles).
- [STABLE.md](./STABLE.md) — locked design decisions.
- [AGENT_TEAM_RESEARCH.md](./AGENT_TEAM_RESEARCH.md) — the research that informed this team shape.
- [decisions/0007-five-role-cowork.md](./decisions/0007-five-role-cowork.md) — ADR for this decision.
