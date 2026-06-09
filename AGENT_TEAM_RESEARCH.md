# AGENT_TEAM_RESEARCH.md

> A research review of multi-agent coding team architectures to inform whetstone's agent-team design.
> Produced 2026-06-09. Reviewer's note: research-grade synthesis, not a meta-analysis. Frameworks in this space change monthly; freshness matters and the calibration here will rot in months.

## How to read this document

This document answers one question: *what kind of agent team should whetstone deploy, today, in a design-only repo, with a personal Anthropic key, on a solo developer's machine plus GitHub Actions?* It is a survey of what is currently shipping (early 2026), what is known to fail, and what a sober deployment looks like.

It is opinionated where the evidence permits, and explicit about its limits where the evidence is thin. The field is loud; the calibration here aims to be honest. If you want the answer in two minutes, skip to the **TL;DR**. If you want the rationale, read on.

---

## TL;DR — what works, what doesn't, what to do for whetstone

**What works today (early 2026):**

- Anthropic's first-party stack: **Claude Code subagents** + **background agents** (`claude agents`, the `--bg` flag) + **Routines** (cloud-scheduled sessions, `/loop` for in-session intervals) + **Claude Code GitHub Actions** (`@claude` mention triggers, GA in v1). This stack covers everything the five named roles need.
- **Single-threaded agents with disciplined subagent delegation.** Cognition's own engineering team (the people who built Devin) [argue against multi-agent collaboration for code](https://cognition.ai/blog/dont-build-multi-agents) and Anthropic's own multi-agent research found 14 distinct failure modes; the production sweet spot is one main agent that *delegates* (not *collaborates*).
- **GitHub as the orchestrator**, not Temporal/Prefect/cron-VM. Issues are the queue; PRs are the work product; GitHub Actions are the runtime; reviews are the gate. For a solo-dev personal project, anything more is over-engineered.

**What doesn't reliably work yet:**

- **True peer-to-peer multi-agent collaboration** ("PM agent debates Developer agent"). Token-burning, fragile, prone to infinite loops. Anthropic's own multi-agent research feature consumes ~15× the tokens of a single chat session and was hard to keep on the rails.
- **Devin-style "fully autonomous" agents for non-trivial work.** Independent eval found ~15% success rate on real-world tasks ([Answer.AI, Jan 2025](https://www.answer.ai/posts/2025-01-08-devin.html)). Cognition has since pivoted toward sub-agent-as-helper models internally.
- **5+ persistent agents disagreeing infinitely** is a documented failure pattern (MAST taxonomy FM-1.1 *step repetition*, FM-1.5 *unaware of stopping conditions*, FM-2.x *inter-agent communication failures*).

**The recommendation for whetstone:**

Build a **2-role team** today, scale to a **3-role team** when implementation starts. Not five separate persistent agents — **five specialized subagent definitions** that any session can delegate to, driven by GitHub issues and a single `loop.md` maintenance prompt.

- **Architect-PM** (one role; merge two of the user's five): runs as the default agent. Owns issue creation, scope, ADRs, PR review. Model: Sonnet 4.5 default, Opus 4.7 for design judgement.
- **Developer**: invoked per issue, opens PR, awaits Architect-PM review. Model: Sonnet 4.5.
- (Deferred until code exists) **Tester** subagent and **UX** subagent: meaningful only after the v1 skeleton exists.

Orchestration: **Claude Code GitHub Actions** + **issue assignment** as the work queue + **Routines** for the nightly "babysit-PRs" loop. No CrewAI, no AutoGen, no LangGraph, no Temporal. Add complexity only when something demonstrably fails.

**Cost realism:** for whetstone's scale (solo, design-doc work now, modest code later, Sonnet-default), expect **$30-100/month** at moderate activity, **$200/month** if you run agent teams or background agents 24/7. The user's $50-200/mo budget fits if discipline is maintained; agent teams (experimental, ~7× tokens) and Opus-for-everything are the two ways to blow past it. See **Cost realism** section for sourced numbers.

**Mode C ("self-iterating" autonomous between check-ins):** **possible** today via background agents + Routines + `loop.md`, but it is the bleeding edge. Expect to babysit it for the first week. Plan for the Mode-B-to-Mode-C ramp, don't jump straight to Mode C.

---

## What the field looks like in early 2026

The space is **half-solved, with a clear winner emerging in the Anthropic-first-party stack** and a strong contrarian consensus forming against pure multi-agent collaboration.

Three big shifts happened across 2025 into 2026:

1. **Devin's halo collapsed.** Launched March 2024 as the first "autonomous AI software engineer" at $500/month. By June 2026 Cognition's individual plans are $20/mo Pro to $200/mo Max — a 25× price drop reflecting reality: independent evaluations showed roughly 15% task success on real-world work, and the product matured toward an IDE-assistant role rather than full autonomy. Cognition's own engineering blog post ["Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents) explicitly walks back the multi-agent vision, recommending single-threaded agents with summarization-based context compression instead.

2. **Claude Code became the de facto agentic coding platform** by shipping primitives in months that the OSS field took years to attempt. By mid-2026 the Anthropic stack covers: subagents (`.claude/agents/*.md`), background agents (`claude agents`, `--bg`), agent teams (experimental, with shared task lists and inter-agent messaging via `SendMessage`), Routines (cloud-hosted scheduled/triggered sessions), `/loop` (in-session polling), the Agent SDK (programmatic library), Managed Agents (hosted REST API), and a GitHub Action that responds to `@claude` mentions. Cursor, Aider, OpenHands, AutoGen and CrewAI all still ship and have their fans, but none combine the polish, model access, and orchestration primitives of the Anthropic-native stack.

3. **GitHub became the default orchestration layer.** GitHub Copilot's coding agent ships as a standard part of paid Copilot plans, picks up issues, opens draft PRs, and runs on GitHub Actions runners with a 59-minute timeout. Claude Code's GitHub Action triggers on `@claude` mentions in issues and PRs. Routines react to `pull_request.opened`, `release.published`. The "issue is the task, PR is the work, review is the gate" pattern is no longer one option among many — it is the path of least resistance for everyone.

What remains unsolved: **long-running autonomous quality** (post-Devin, no one credibly claims hands-off ship-it-to-prod reliability), **agent-to-agent context sharing** (still token-expensive and fragile), and **observability/budgets** (most tools provide visible spend but not preemptive caps that actually stop runaway costs).

---

## Topic 1 — Existing multi-agent coding frameworks

### Claude Code subagents

**What it is:** Specialized AI assistants defined in Markdown with YAML frontmatter at `.claude/agents/*.md` (project) or `~/.claude/agents/` (user). Each runs in its own context window with custom system prompt, tool restrictions, model choice, and permission mode. Source: [Subagents docs](https://code.claude.com/docs/en/sub-agents).

**Key capabilities for Mode C:**
- Per-agent `tools`/`disallowedTools` allowlist (e.g., reviewer is read-only).
- Per-agent `model` selection: Haiku for cheap research, Sonnet default, Opus for judgement.
- `permissionMode`: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`.
- `isolation: worktree` runs the subagent in a fresh git worktree, branched from default — file isolation for free.
- `memory: project|user|local` gives the subagent a persistent directory at `.claude/agent-memory/<name>/` that survives across sessions; useful for accumulating codebase knowledge.
- `hooks` define `PreToolUse`/`PostToolUse`/`Stop` callbacks — the right place to enforce hard rules like "block writes to `decisions/` without ADR confirmation."
- `background: true` makes the subagent always run in the background (auto-denies prompts).
- Built-in subagents: **Explore** (Haiku, read-only, fast codebase search), **Plan** (read-only, used in plan mode), **general-purpose** (full tools, multi-step work).

**Hard limits:**
- **Subagents cannot spawn other subagents.** No nested delegation. Workaround: chain from main, or use `Skills`, or use agent teams (see below).
- Subagents do not see the main conversation history. They get system prompt + delegation task message + CLAUDE.md + git status. Bring your own context.
- `AskUserQuestion` is not available to subagents — they cannot prompt the user mid-run.
- Background subagents auto-deny any tool call that would prompt; if they need permission they fail silently and must be re-run interactively.

### Claude Code agent teams (experimental)

**What it is:** Multiple Claude Code sessions coordinating via a shared task list and direct inter-agent messaging (`SendMessage` tool). One lead, multiple teammates. Source: [Agent teams docs](https://code.claude.com/docs/en/agent-teams).

**Why it's notable:** This is the closest thing to "the five-role team" the user described, shipped from Anthropic itself. Teammates message each other directly (not just back to lead), share a task list with file-locking for claim-races, and can be reused via the same subagent definitions.

**Why it isn't the answer for whetstone (yet):**
- **Experimental, disabled by default** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Documented limitations include: no session resumption after `/resume`, task status can lag, no nested teams, one team per lead, lead is fixed for life of the team.
- **Cost: roughly 7× the tokens of a standard session** when teammates run in plan mode (per [Claude Code costs docs](https://code.claude.com/docs/en/costs#agent-team-token-costs)). For a solo personal project that is brutal.
- **Coordination overhead** — Anthropic's own guidance is "3-5 teammates for most workflows," and they explicitly note coordination overhead grows non-linearly past 5. For a one-developer project with 12 design files, 5 teammates would mostly talk to each other.
- The architecture suits parallel exploration (review PR from 3 angles, debug with competing hypotheses) and large parallel implementation, not solo sequential design work.

**Verdict for whetstone:** keep in the toolbox; not the day-1 deployment. Use it ad hoc when a specific task genuinely benefits (e.g., "review this design from a UX, performance, and conviction-fidelity angle in parallel" — three teammates for one hour). Not as the everyday architecture.

### Claude Code background agents + agent view

**What it is:** `claude agents` opens a one-screen dashboard of background sessions: dispatched tasks running concurrently without a terminal attached. A separate per-user supervisor process hosts them; they survive when you close your shell. Each dispatched session runs in its own git worktree under `.claude/worktrees/` by default. Source: [Agent view docs](https://code.claude.com/docs/en/agent-view).

**Why it's the right primitive for Mode C:**
- `claude --bg "fix the TODO in DRAFT.md about Echo cadence"` starts a session that runs detached. You walk away.
- The dashboard groups sessions by **Needs input / Ready for review (PR open) / Working / Completed**. PR status is colour-coded by check status, so the user sees in one screen "this PR is green, that one needs me."
- Combined with `claude --agent <name> --bg "<prompt>"` you can dispatch role-specialized sessions.
- Pinned sessions (`Ctrl+T`) keep running through idle. Supervisor restarts surviving sessions automatically on Claude Code auto-update.
- **Sessions are local to the machine.** They survive sleep, not shutdown. This matters for the user's "while I sleep" target.

**Limits:**
- Local-only — if the machine shuts down, sessions show as failed (recoverable by attaching).
- Each background session consumes subscription quota independently; 10 in parallel uses quota 10× as fast.

### Claude Code Routines (cloud-scheduled sessions)

**What it is:** Saved Claude Code configurations (prompt + repositories + connectors) that run on Anthropic-managed cloud infrastructure on a schedule, via API webhook, or on GitHub events. Source: [Routines docs](https://code.claude.com/docs/en/routines).

**Why it matters for Mode C:** This is the *true* "while I sleep" primitive. Background agents need your machine on. Routines do not.

- Triggers: scheduled (hourly minimum), API (`POST /v1/claude_code/routines/{id}/fire`), GitHub events (`pull_request.opened`, `pull_request.synchronized`, `release.*`).
- One routine can combine all three trigger types.
- Pro, Max, Team, Enterprise plans only (no API-key tier as of June 2026). Subject to a per-account daily run cap.
- Runs in a managed cloud environment; can only push to `claude/`-prefixed branches by default (safety rail).
- Use cases the docs name: backlog maintenance, alert triage, bespoke code review, deploy verification, docs drift, library port.

**Limits to know:** All actions appear as the routine owner (so commits show *you* in GitHub history). Network access defaults to a trusted allowlist; custom domains need configuration. No permission prompts during run — the routine runs autonomously, which is the point and also the danger.

### Claude Code GitHub Action (`anthropics/claude-code-action@v1`)

**What it is:** A GitHub Action that responds to `@claude` mentions in issues and PRs, opens PRs from issues, runs automated PR reviews. Source: [GitHub Actions docs](https://code.claude.com/docs/en/github-actions).

**For whetstone this is the cheapest entry point:**
- Tag `@claude` in an issue → it opens a PR.
- Tag `@claude` in a PR comment → it addresses your feedback.
- Schedule a `cron: "0 9 * * *"` workflow → daily Claude-driven report.
- Runs on GitHub-hosted runners (uses your Actions minutes; 2000 free/month on personal accounts).
- Costs: GitHub Actions minutes + Anthropic API tokens (per the API key you set in repo secrets).
- v1.0 unified the configuration — `prompt` for instructions, `claude_args` for CLI passthrough (`--max-turns`, `--model`, `--allowedTools`).

### Claude Agent SDK

**What it is:** The same agent loop, tools, and context management that power Claude Code, exposed as a Python/TypeScript library. Source: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

**When to reach for it (vs subagents):** When you want to run agents *outside* Claude Code — embedded in your own application, in a CI pipeline that doesn't use the canned GitHub Action, or in a service you operate. For whetstone, **you almost certainly don't need this.** The CLI + subagents + GitHub Action cover it.

Note: starting June 15, 2026, Agent SDK and `claude -p` usage on subscription plans draws from a separate "Agent SDK credit" allowance, distinct from interactive quota. Plan accordingly if you go this route.

### Devin (Cognition AI)

**Current state (June 2026):** $20/mo Pro, $80/mo Teams base + $40/seat, $200/mo Max. (Down from $500/mo at March 2024 launch.) Uses Cognition's own SWE-1.x models (SWE-1.5 frontier-size from Oct 2025, SWE-1.6 in early 2026) and also offers Sonnet 4.5/Opus paths.

**Independent evaluation:** [Answer.AI, January 2025](https://www.answer.ai/posts/2025-01-08-devin.html): of 20 representative tasks, **14 failed, 3 succeeded, 3 inconclusive** — roughly 15% real-world success rate. Failures clustered around: tunnel vision (fixates on one approach), over-engineering, false confidence (presses forward instead of flagging blockers), unpredictability (no pattern to predict success).

**Quote that stuck:** *"Tasks it can do are those that are so small and well-defined that I may as well do them myself, faster."*

**Verdict for whetstone:** **No.** Even at $20/mo Pro, the autonomy ceiling is below what a solo developer using Claude Code directly can achieve. Devin's UX (Slack, async tasks) is genuinely good but the underlying success rate doesn't justify a second tool on top of Claude Code.

### OpenHands (formerly OpenDevin)

**Current state:** Active OSS project ([docs.openhands.dev](https://docs.openhands.dev/)). Ships as Agent Canvas (browser UI + backend), OpenHands Cloud (managed), OpenHands Enterprise (self-host via Kubernetes), and the Software Agent SDK. MIT license for core; enterprise/ dir is source-available with restrictions.

**Strengths:** Model-agnostic ("Claude, GPT, or any other LLM"), strong integrations (GitHub, GitLab, Bitbucket, Slack, Jira, Linear), free if self-hosted. Genuine OSS alternative for those who can't or won't use Claude Code.

**Active issues (from the GitHub tracker as of mid-2026):** agent-loop dormancy ("user message on finished conversation never triggers /run"), 5-minute timeout with Ollama, git config sometimes not set from settings, memory bloat on poll_agent_servers. Themes: cloud reliability gaps, performance bottlenecks, agent responsiveness regressions.

**Verdict for whetstone:** **Not for now.** Higher setup cost, more moving parts, weaker integration with the user's existing Claude Code workflow. Worth revisiting if the user later wants to host on their Azure VM and run agents continuously without depleting personal Claude Code quota.

### AutoGen (Microsoft Research)

**Current state:** Post-rewrite layered architecture: `autogen-core` (event-driven), `autogen-agentchat` (conversational), `autogen-ext` (Docker, MCP, OpenAI Assistants), `autogenstudio` (web UI for no-code prototyping). gRPC runtime for distributed agents.

**Strengths:** Microsoft-backed, clean layered abstractions, strong .NET path (potentially relevant given whetstone's MAUI stack), Studio is the lowest barrier of any agent framework.

**Weaknesses:** Cognition specifically called out AutoGen as "actively pushing concepts which I believe to be the wrong way of building agents." The peer-to-peer multi-agent debate pattern AutoGen popularized is exactly the failure mode (FM-2.x in MAST taxonomy) the field has been backing away from. GroupChat is fun but unreliable for code.

**Verdict for whetstone:** **No** — wrong tool for a solo personal project. Reach for it if you ever build a multi-agent component *inside* whetstone for users (you won't, per scope).

### CrewAI

**Current state:** Crews (collaborative agents) + Flows (state/control-flow orchestration). The framework's own docs note that crew-only setups aren't production-grade — you need Flows. Real production case studies are sparse outside their own marketing.

**Honest assessment:** Role-based agents look elegant ("PM, Developer, Tester") but in practice you end up writing a lot of Flow code to keep them from talking past each other. Token usage scales with number of crew members. The MAST taxonomy's FM-2.2 (information withholding) and FM-2.3 (information distortion) are particularly hard to avoid in role-based crews.

**Verdict for whetstone:** **No.** The role-based metaphor is appealing and *exactly* what the user asked for — and exactly what Cognition's "Don't Build Multi-Agents" argues against. Better to map the same five roles onto five subagent *definitions* invoked from a single main session.

### LangGraph

**Current state:** Graph-based stateful multi-agent orchestration. Nodes are functions/agents, edges define flow, state is a typed dict, checkpointing for time-travel debugging, native human-in-the-loop.

**Strengths:** Explicit and debuggable. When you actually need cycles (e.g., "iterate until tests pass") and want to see the graph, LangGraph is the most honest tool for the job.

**Weaknesses:** Tied to LangChain ecosystem (which many find over-abstracted), verbose graph definitions, performance overhead from state serialization on every step, learning curve.

**Verdict for whetstone:** **No** for the agent team itself. *Maybe* relevant much later if a deeply scripted workflow becomes necessary (the same role Claude Code's "dynamic workflows" / `/batch` skill fills natively).

### GitHub Copilot coding agent

**Current state:** Ships in all paid Copilot plans. Assignable to issues. Opens draft PRs. Works on GitHub-hosted runners, **59-minute timeout** per session, one branch per task, one PR per task, single-repo-per-session. Triggered from the agents panel on GitHub, from Issues, from VS Code, from `@copilot` in PR comments, or via automated triggers.

**Honest assessment:** Genuine, working autonomous agent at no extra cost (within plan minutes). Excellent for well-scoped issues. Limitations match the rest of the field: complex multi-system tasks underperform.

**Verdict for whetstone:** **Optional second hand.** If the user already has Copilot, it's a free way to pick up small well-defined issues. But it's a Copilot product first, and the user's primary tooling is Claude Code. Not worth optimizing for at the start.

### Other things shipped in 2025 worth knowing about

- **Aider's architect mode** (architect model → editor model) is still a respected workflow for people who don't use Claude Code; not multi-agent in the modern sense, more "two-step pipeline."
- **Cursor's agents/Composer**: solid IDE-embedded agent path. Not the user's tool.
- **OpenAI Codex agent** (the 2025 reboot): operates similarly to Claude Code's GitHub Action. No reason to dual-stack for whetstone.

---

## Topic 2 — Orchestration patterns for multi-agent code teams

There are five patterns the field has tried. The honest results:

### Hierarchical (Architect supervises Developer)

**How it ships:** Claude Code's main session + subagent pattern. Anthropic's own internal multi-agent research feature uses orchestrator-worker: Opus 4 lead, Sonnet 4 subagents. They report **90.2% improvement over single-agent Opus 4** on internal research evals — but also **~15× the tokens of a chat**, and "early agents made errors like spawning 50 subagents for simple queries, scouring the web endlessly for nonexistent sources" ([Anthropic engineering blog](https://www.anthropic.com/engineering/built-multi-agent-research-system)).

**For code work specifically:** the hierarchical pattern works when delegation is **task-scoped and the supervisor synthesizes**. It does *not* work when both agents try to drive ("PM agent assigns to Developer agent who pushes back to PM agent" is a known infinite-loop generator — MAST FM-1.5 *unaware of stopping conditions*).

**Recommendation for whetstone:** Yes — but the supervisor is **the human**, not another agent. The main Claude Code session is the worker; the user reviews. Use subagents for *delegated investigation* and *PR review*, not for *opinion exchange*.

### Queue-based (issues as the queue, agents claim work)

**How it ships:** GitHub Issues + assignee field. GitHub Copilot coding agent's primary entry point. Claude Code Routines on `pull_request.opened` GitHub trigger. `gh issue list --assignee @claude` works.

**Pros:** Persistent state outside any agent, transparent to the human, native to GitHub. Locking via assignee field. Failure tolerant — a crashed session leaves the issue unassigned.

**Cons:** Requires discipline ("agent must check out issue before working"). No native priority queue beyond labels.

**Recommendation for whetstone:** Yes — this is the work queue. Issues are the spec. PR is the deliverable. Comments are the conversation.

### Event-driven (PR opened triggers Tester)

**How it ships:** GitHub Actions native + Claude Code's `@claude` mention trigger. Routines GitHub triggers (`pull_request.opened`, `synchronize`, `closed`).

**Pros:** Zero polling cost. Clean separation.

**Cons:** GitHub Actions runners have a 60-minute hard cap on free tier; a long Claude session may need to break into chunks.

**Recommendation for whetstone:** Yes — for "review every PR" the right answer is a Routine or a GitHub Action workflow, not a polling agent.

### Consensus / voting / debate

**How it ships:** AutoGen GroupChat, CrewAI hierarchical mode with multiple reviewers, custom orchestration.

**Pros:** Sometimes produces better answers on open-ended research (multi-agent debate, "investigate hypotheses adversarially" — Claude Code's agent teams docs cite this as a real use case).

**Cons:** **Token-burning.** ~15× tokens for marginal gains on most tasks. The MAST paper found "performance gains on popular benchmarks are often minimal." The Cognition "Don't Build Multi-Agents" essay is exactly about how debate produces divergence, not convergence, when context isn't shared perfectly.

**Recommendation for whetstone:** **No, except as a one-off.** Spawn an agent team only when a *specific* task benefits from genuinely parallel perspectives (e.g., "review this ADR from UX, perf, and conviction-fidelity angles simultaneously"). Never as the everyday architecture.

### Hub-and-spoke vs peer-to-peer

**Hub-and-spoke** (Claude Code subagents, hierarchical orchestrator): supervisor talks to N workers, workers don't talk to each other. *Reliable.*

**Peer-to-peer** (Claude Code agent teams with `SendMessage`, AutoGen GroupChat): workers talk to each other. *Fragile, more powerful in principle, token-expensive.*

**Recommendation for whetstone:** Hub-and-spoke. The user is the hub for high-level direction; the main Claude Code session is the hub for delegation. No peer-to-peer until/unless a specific need surfaces.

---

## Topic 3 — GitHub-native vs custom orchestration

The question: can the GitHub issue/PR system *be* the orchestrator? Yes, fully, for whetstone's scale. The argument for adding a separate orchestrator (Temporal, Prefect, Airflow, cron-on-VM) only starts paying off above a threshold whetstone won't reach in v1.

**GitHub as orchestrator works because:**
- Issues = work queue with native priorities (labels) and assignment (locking by assignee).
- PRs = work product with built-in review/approval gates.
- Comments = inter-agent and human-agent communication.
- GitHub Actions = the runtime; Routines GitHub triggers = event hooks.
- All state visible to the human, audit log built in, free for public repos.

**GitHub Actions as the runtime:**
- Free tier: 2000 minutes/month on personal accounts (Linux runners). Generous for whetstone.
- 60-minute job cap by default (changeable).
- Concurrency controls prevent two agent jobs from stepping on the same PR.
- Caveat: Actions runners are ephemeral — agent state lives in the repo (commits, PRs, comments) or in artifacts.

**When you would need a separate orchestrator:**
- Cross-repo coordination spanning more than ~5 repos with complex dependencies. Whetstone has one repo. Not relevant.
- Long-running stateful workflows (>24 hours of orchestration logic with retries). Whetstone tasks are issue-sized.
- Sophisticated retry/backoff/sliding-window logic that GitHub Actions can't express. Use Routines instead.
- True 24/7 production processing of customer events at high volume. Whetstone is personal.

**Hybrid (GitHub for state, separate runner for execution):** This is what **Claude Code Routines** *is*. It's the right level of "managed infrastructure" for a solo personal project. The user does not need to stand up their own.

**Recommendation:** GitHub is the orchestrator. Routines for events that need cloud execution. Background agents (`claude --bg`) for events that need the user's machine. Don't introduce a third system.

---

## Topic 4 — Failure modes and mitigations

The most rigorous source is the **MAST taxonomy** ([Cemri et al., 2025, "Why Do Multi-Agent LLM Systems Fail?", arXiv:2503.13657](https://arxiv.org/abs/2503.13657)): 14 failure modes across 1,600+ annotated traces of 7 popular multi-agent frameworks (ChatDev, MetaGPT, Magentic-One, AutoGen, etc.), models including GPT-4, Claude 3, Qwen2.5, CodeLlama, inter-annotator agreement κ=0.88.

### The 14 failure modes

**Category 1 — Specification & Instruction Failures**
- FM-1.1 **Step repetition** — agent repeats the same action without progressing. *Most common in code agents.*
- FM-1.2 **Disobey role specification** — agent acts outside assigned role boundaries.
- FM-1.3 **Conversation reset** — interaction context inappropriately restarted.
- FM-1.4 **Loss of conversation history** — agent loses prior context (especially after compaction).
- FM-1.5 **Unaware of stopping conditions** — agent doesn't recognize when to terminate. *The "I'll just clean up one more thing" forever loop.*

**Category 2 — Inter-Agent Communication Failures**
- FM-2.1 **Conversation reset (multi-agent)** — communication between agents resets.
- FM-2.2 **Information withholding** — agent fails to share necessary information.
- FM-2.3 **Information distortion** — information corrupted in transit between agents. *The Cognition "Flappy Bird" failure: one agent builds Mario background, another builds non-game bird.*

**Category 3 — Task Execution Failures**
- FM-3.1 **Premature termination** — system stops before completing the task.
- FM-3.2 **Incorrect result** — agent produces wrong output. *Hallucinated capability lives here ("I committed the change" when nothing happened).*
- FM-3.3 **Resource mismanagement** — poor handling of tools/resources. *Cost runaways live here.*
- FM-3.4 **Cascading errors** — one agent's error propagates through the system.

**Category 4 — Design & Architectural Failures**
- FM-4.1 **Suboptimal agent topology** — poor structural design of agent interactions. *Five-role peer-to-peer for a solo project is this.*
- FM-4.2 **Lack of verification** — no mechanism to check agent outputs. *The deepest, hardest-to-fix failure.*

### Specific failures observed in shipped systems

- **Spawning 50 subagents for simple queries** — Anthropic's own research system, early production. ([Anthropic engineering blog](https://www.anthropic.com/engineering/built-multi-agent-research-system).)
- **Distracting each other with excessive updates** — same source.
- **Choosing SEO-optimized content farms over authoritative sources** — same source, found by humans, missed by autoeval.
- **Tunnel vision: fixates on one approach** — Devin in Answer.AI eval.
- **Spending days attempting impossible tasks, hallucinating nonexistent features** — Devin.
- **Polluted main branch from low-quality PRs merged before human catches** — anecdotal in the wild; mitigation is mandatory human review (whetstone's "user pushes manually" rule already addresses this).

### Mitigations grounded in shipped practice

| Failure mode | Mitigation that actually works |
|---|---|
| FM-1.1 step repetition | `maxTurns` cap in subagent frontmatter; `--max-turns` in Claude Code CLI |
| FM-1.5 unaware of stopping | `Stop` hook that runs a check (build/test/lint passes); Claude Code overrides after 8 consecutive blocks |
| FM-2.2/2.3 information loss between agents | **Don't have multiple agents.** Use hub-and-spoke with delegation, not collaboration. Or: subagents return to filesystem (Anthropic pattern), not to chat |
| FM-3.2 hallucinated capability | Require evidence in output (Claude Code best-practice: "Have Claude show evidence rather than asserting success") |
| FM-3.3 cost runaway | Per-workspace spend limits on Claude API; `/usage-credits` monthly cap; `--max-turns` cap; subscription rate limits provide a final stop |
| FM-3.3 cost runaway (process side) | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to force earlier compaction; per-routine daily-run cap |
| FM-4.2 lack of verification | Adversarial review subagent in a fresh context; mandatory PR human review (whetstone rule); `/code-review` skill |
| FM-1.4 loss of conversation history (after compaction) | Structured note-taking pattern (Anthropic: "agents persist notes outside the context window, retrieve later"); subagent `memory` directories |
| FM-4.1 suboptimal topology | **Start with fewer agents, add only when a measurable pain shows.** |

The single most-cited mitigation across Anthropic, Cognition, and the MAST paper: **make the agent verify its own work**, and have a *fresh-context* reviewer agent check the diff against the spec.

---

## Topic 5 — Cost realism for late 2025 / early 2026

### Per-model pricing (Anthropic, from [official pricing docs](https://platform.claude.com/docs/en/about-claude/pricing))

| Model | Input | Output | 5m cache write | Cache hit | Batch input | Batch output |
|---|---|---|---|---|---|---|
| **Claude Opus 4.7 / 4.8** | $5/MTok | $25/MTok | $6.25/MTok | $0.50/MTok | $2.50/MTok | $12.50/MTok |
| **Claude Sonnet 4.5 / 4.6** | $3/MTok | $15/MTok | $3.75/MTok | $0.30/MTok | $1.50/MTok | $7.50/MTok |
| **Claude Haiku 4.5** | $1/MTok | $5/MTok | $1.25/MTok | $0.10/MTok | $0.50/MTok | $2.50/MTok |

Notable: **Opus 4.5+ prices dropped 3× vs Opus 4** ($15→$5 input, $75→$25 output). That changes the calculus significantly for "use Opus for the hard stuff."

Cache hits are **10% of base input price**. Batch is **50% off both input and output**. Web search is **$10 per 1,000 searches** plus token cost. Web fetch is free except for the tokens of fetched content.

### Real-world monthly spend benchmarks

From [Claude Code costs docs](https://code.claude.com/docs/en/costs): enterprise average is **$13 per developer per active day**, **$150-250 per developer per month**, with **90% of users staying below $30/active day**. These are interactive single-developer numbers.

### What blows up cost (in order of severity)

1. **Agent teams**, per Anthropic's own docs: **~7× tokens** of standard sessions when teammates run in plan mode. Each teammate has its own context window, runs as a separate Claude instance. Five teammates → ~35× a single chat session.
2. **Multi-agent research patterns**: ~15× tokens of chat (Anthropic's own measurement on their research feature).
3. **Opus-for-everything**: 5× Sonnet's pricing per token, plus tokenizer change in Opus 4.7+ uses up to **35% more tokens for the same text**.
4. **Running background agents 24/7**: each pinned session keeps consuming when nudged, supervisor restarts on auto-update.
5. **`bypassPermissions` mode** with a stuck agent: no human pause to stop a runaway loop. *This is the most dangerous knob in the box.*
6. **MCP servers loaded into context**: defer (default) or you eat tool-listing tokens on every message.
7. **CLAUDE.md bloat**: loaded every session.

### What stays cheap

1. **Haiku for research/exploration**: Claude Code's built-in `Explore` subagent uses Haiku by default. Cost-efficient.
2. **Prompt caching**: 10% of base for cache hits. Most subagent invocations from the same parent benefit.
3. **Batch API**: 50% off, when you don't need realtime.
4. **`/clear` between tasks**: free, dramatic.
5. **Subagents (without teams)**: results return as summaries, not full context.
6. **`gh` CLI over GitHub MCP server**: more context-efficient.

### Whetstone projection (early 2026 calibration)

For a solo developer, design-doc work now, modest code work starting in weeks:

- **Low activity** (~1 hour/day, mostly Sonnet, occasional Haiku subagents): **$15-30/mo**
- **Medium activity** (3-4 hours/day, mixed model use, weekly Routine, GitHub Action on PR open): **$40-90/mo**
- **High activity** (background agents nightly, Opus for design reviews, GitHub Action on every commit): **$120-200/mo**
- **Mode-C-with-agent-teams** (3-5 teammates running for hours daily): **$300-800/mo** — *flagging loudly per the user's brief.*

The user's stated $50-200/mo budget fits *if* the team architecture stays simple (hub-and-spoke with subagents, not agent teams as everyday architecture). Switching one role to Opus for design review is fine; making everything Opus is not.

**Cost controls to set on day 1:**
1. Workspace spend limit in Claude Console: hard cap, e.g., $200/mo.
2. `--max-turns 15` in CLAUDE.md and on agent invocations as a default.
3. Routine daily-run cap (Anthropic-enforced; aware of it, plan within it).
4. Sonnet 4.5 as default model; Opus only when explicitly invoked by name.
5. Visible status line showing context % and session cost.

---

## Topic 6 — Minimum viable team for whetstone

### Is five roles right?

**No.** The user's five roles (Architect, PM, Developer, Tester, UX) are how a *human* engineering team is structured, where each role exists because no human can be all five. **An LLM agent does not have that constraint.** A single Claude session — especially one running Sonnet 4.5 or Opus 4.7 — has access to all five competencies natively. Splitting them into five separate persistent agents creates communication overhead without proportional capability gain, and exposes you to FM-2.x communication failures.

Cognition's "Don't Build Multi-Agents" makes this argument forcefully. Anthropic's own multi-agent research blog reports the orchestrator-worker pattern wins *for parallel research*, not for sequential design or implementation work.

### What single-agent-with-roles vs separate-agent-per-role looks like operationally

| | Single agent with multiple subagent definitions | Separate persistent agent per role |
|---|---|---|
| **How invoked** | One main Claude Code session; subagents delegated on demand (`@code-reviewer look at the diff`, `Use the architect subagent to draft an ADR`) | Five `claude --bg` sessions running concurrently, one per role |
| **Context** | Shared via main conversation; subagents get fresh context with delegation prompt | Each agent has its own isolated context, no shared state |
| **Cost** | Roughly 1× chat baseline + subagent overhead per delegation | 5× chat baseline, continuously |
| **Coordination** | Sequential; deterministic; debuggable | Asynchronous; emergent; harder to debug |
| **Failure mode** | Main agent gets confused, you `/clear` and restart | One agent goes off-rails while you sleep; cost meter spinning |
| **Right when** | One human directing; sequential or lightly parallel work; total work fits one focused day | Genuinely parallel, independent work where context isolation pays off |

For whetstone, the first column wins. The user is the supervisor; one main session delegates.

### Smallest team that can autonomously make progress while the user sleeps

**Two roles. Three at most.**

- **Architect-PM** (one role): default agent. Owns design coherence, ADR drafting, issue creation, PR review against convictions and STABLE.md. Subagent definition uses Sonnet 4.5 default with Opus 4.7 for explicit deep-review tasks.
- **Developer**: invoked per issue. Opens PRs. Awaits review. Subagent definition with Sonnet 4.5, full edit tools, isolated worktree.
- (Optional from day 1, mandatory once code exists) **Reviewer/Tester**: a *read-only fresh-context* subagent invoked on PR open to give an adversarial second opinion before the human reviews. Sonnet 4.5, read-only tools.

The user's PM/Architect distinction (and UX/Tester distinction) is a human-team artifact. For an agent team:

- **PM and Architect are one role** in a solo project because both are "the person who decides what we build and whether we should build it." Merging them avoids the FM-1.5 (stopping condition) loop of "PM says yes, Architect says no, repeat."
- **UX designer** as a separate agent makes sense **only once there is UI to design**. Defer until a v1 wireframe exists.
- **Tester** as a separate persistent agent is over-engineered for whetstone v1, which is unit-test-only against pure logic (per STABLE.md → Tests). A Reviewer subagent that runs `dotnet test` is sufficient.

### Recommended subagent shape (the five-but-not-five)

Define **five subagent files** in `.claude/agents/`, but operate them through one main session:

1. `architect-pm.md` — design judge, issue creator, ADR scribe. Sonnet (Opus on explicit request). All tools except `Write`/`Edit` outside of `decisions/`, `DRAFT.md`, `BACKLOG.md`. Memory: `project`.
2. `developer.md` — feature implementer. Sonnet. Full edit tools. `isolation: worktree`. `maxTurns: 30`.
3. `reviewer.md` — fresh-context PR reviewer. Sonnet. Read-only tools only. `model: sonnet`. Invoked on every PR.
4. `explorer.md` — codebase research. Haiku. Read-only. (The built-in `Explore` does this; defining your own is optional unless you want it to know whetstone-specific conventions.)
5. `ux-designer.md` — *deferred until UI exists.* Stub the file but disable until v1.5.

Use them as **delegation targets from a single main session**, not as five concurrent persistent agents.

---

## Topic 7 — Human-in-the-loop placement

### Where the user stays required

Hard stops, no exceptions, baked into hooks where possible:

- **Any decision touching a conviction (the six in STABLE.md).** A `PreToolUse` hook on `Write|Edit` that checks the target file is `STABLE.md` → block unless paired with an explicit ADR in the same commit.
- **Any `git push`.** Already in `AGENTS.md`. Enforce with a hook on `Bash` that rejects `git push`.
- **ADR commits** must come paired with `STABLE.md` updates (the same-commit rule). Hook on `Bash` for `git commit` that validates this if `decisions/` files are staged.
- **Adding a new dependency** (NuGet, npm, anything). Hook on `Bash` that rejects `dotnet add package`, `dotnet add reference` of unknown sources, `npm install`, etc., without a `.claude/approved-deps` allowlist entry.
- **Adding a new interface beyond the three real seams.** Hook on `Edit|Write` of `*.cs` checking for `public interface` keywords, requiring an `--allow-new-interface` flag in the commit message.
- **Anything in BACKLOG.md.** Hook checks PR diff against BACKLOG.md content; flag if the diff implements a backlog item.
- **`bypassPermissions` mode** — require user to type the mode interactively once; Anthropic already enforces this. Do not enable for background agents.
- **Changing a Direction** (the per-subject identity anchor in STABLE.md) — agents do not edit Directions.
- **Cost-control changes** — daily budget cap, per-request token cap, spend log: agents do not modify the values, only the UI.
- **Voice scope changes** — pronunciation scoring, TTS, streaming audio, Chinese literary scoring all out of v1 per ADR 0006. Hook rejects edits that introduce these.

### Where the team genuinely operates without the user

Safe for autonomous progress, especially during Mode-C sleep cycles:

- **Drafting an ADR** in `decisions/` (status: `Proposed`, never `Accepted` without user approval).
- **Updating DRAFT.md** to reflect open questions, blocked tasks, completed sub-design work.
- **Creating GitHub issues** with proposed scope and acceptance criteria.
- **Opening draft PRs** that implement an in-scope, accepted issue.
- **Adding tests** for already-implemented logic (per the STABLE.md test scope: pure logic only).
- **Refactoring within a single file** for clarity, when tests still pass.
- **Researching** — reading RESEARCH.md, scanning literature for cited claims, summarizing findings.
- **Responding to its own PR review** when the review came from another agent (the Reviewer subagent).

### Published patterns for "what to escalate" vs "what to proceed on"

The three patterns the field has converged on:

1. **Gate-based** (what whetstone needs): hooks block specific actions; everything else proceeds. Explicit, debuggable, deterministic. Claude Code's `Stop` hook and `PreToolUse` hook are exactly this.

2. **Budget-based**: agent has a budget (turns, tokens, dollars); when exhausted, escalates or stops. Claude Code's `--max-turns`, workspace spend limits.

3. **Confidence-based**: agent self-assesses likelihood of correctness and escalates when low. **Don't trust this alone.** The Devin reviews showed "false confidence" was its top failure mode. Use as a soft signal layered onto gate-based.

### How other projects handle "the agent is about to commit something the user would push back on"

Two patterns:

- **Preemptive ask**: agent uses `AskUserQuestion` (Claude Code native tool) when it detects ambiguity in scope or convictions. The user is interrupted but the cost is one prompt vs an undone PR.
- **Review-after**: agent commits, opens PR, human reviews before merge. The user's existing rule ("Direct push to main, agents do not push") already implements this. Trust the rule.

For whetstone, **both**: preemptive ask for conviction-adjacent or scope-shift decisions; review-after for everything else. The reviewer subagent provides the additional pre-human check.

---

## Recommended team shape for whetstone

### Day 1 deployment: 2 roles, 1 surface (Claude Code)

**Architect-PM** (default main session agent) and **Developer** (subagent + spawned via background sessions).

```
~/.claude/                           # User-level fallbacks
└── agents/
    └── (none for now; project-scoped is enough)

Q:/src/whetstone/
├── .claude/
│   ├── agents/
│   │   ├── architect-pm.md          # Default main session via `agent` setting
│   │   ├── developer.md             # Worker, full tools, worktree-isolated
│   │   ├── reviewer.md              # Read-only PR reviewer, fresh context
│   │   ├── explorer.md              # Optional; Haiku research subagent
│   │   └── ux-designer.md           # STUB; do not enable until v1.5
│   ├── settings.json                # agent: "architect-pm"; permissions; hooks
│   ├── settings.local.json          # User-specific (gitignored)
│   ├── loop.md                      # Nightly maintenance prompt
│   └── skills/
│       └── (per repo skills as they emerge)
├── .github/
│   └── workflows/
│       └── claude-pr-review.yml     # @claude mention + Routine fallback
└── (existing whetstone files)
```

Why this shape:

- **One main session = one supervisor.** Hub-and-spoke avoids the multi-agent fragility documented in MAST and Cognition's essay.
- **Two real roles** reflects whetstone's actual structure: someone deciding *what*, someone implementing *what*. The Tester and UX roles emerge only when there is code and UI to test/design.
- **Three subagents** (developer, reviewer, explorer) handle delegation cleanly. Five subagent *definitions* on disk gives the named-role flexibility the user wanted without the cost overhead.
- **GitHub is the queue.** Issues drive work. The reviewer subagent runs on every PR (via the workflow file) before the human reviews.

### Orchestration choice: GitHub-native + Claude Code, no third system

- **Work queue:** GitHub Issues. Architect-PM creates issues with `Acceptance criteria` and `Convictions touched` sections in the body.
- **Work claiming:** GitHub issue assignment to `@claude` (via Routine GitHub trigger) or `@<user>` (when human picks it up).
- **Work execution:** Three options, mix as needed:
  - `claude --bg --agent developer "implement issue #N"` for machine-local background sessions (during the day).
  - Claude Code GitHub Action `@claude implement` on the issue (uses Actions minutes; no need for laptop to be on).
  - Routine triggered on `pull_request.opened` to invoke the reviewer subagent for first-pass PR review.
- **Work review:** Reviewer subagent's findings appear as PR comment. Human reviews and merges. User pushes manually per AGENTS.md.
- **Nightly maintenance:** `loop.md` defines the Architect-PM maintenance loop (review unmerged PRs, address review comments on draft PRs, summarize day's progress to DRAFT.md, never start new initiatives).

### Models

- **Architect-PM default:** Sonnet 4.5. Opus 4.7 on explicit invocation (`/effort high` or task that explicitly names the model). Haiku for the explore subagent.
- **Developer default:** Sonnet 4.5. Sonnet handles most coding tasks well at $3/MTok input. Haiku is too weak for implementation; Opus is overkill.
- **Reviewer default:** Sonnet 4.5. The cost matters more here because every PR triggers it.
- **Explorer:** Haiku 4.5 explicitly.

### Memory and hooks

- All four enabled subagents get `memory: project` so codebase patterns accumulate in `.claude/agent-memory/`. This survives across sessions, helps reviewer become whetstone-aware over time.
- Hooks (in `.claude/settings.json`):
  - `PreToolUse: Bash` → reject `git push`, `git reset --hard`, `git clean -f`, `git push --force`, `--no-verify`.
  - `PreToolUse: Edit|Write` → reject edits to `STABLE.md` not paired with a staged `decisions/*.md` file in the same commit.
  - `PreToolUse: Bash` → reject `dotnet add package`, `npm install`, etc., without `.claude/approved-deps` allowlist (file doesn't exist yet; create as empty).
  - `Stop` → run `dotnet format --verify-no-changes` (once code exists) before allowing the session to declare done.
  - `SubagentStop: reviewer` → ensure reviewer's findings posted as PR comment, not just spoken to chat.

---

## Recommended deployment plan

### Day 1 — Setup (1-2 hours)

1. Read this document; confirm shape.
2. Create `.claude/agents/architect-pm.md`, `developer.md`, `reviewer.md`, `explorer.md`. Use `/agents` interactive flow.
3. Create `.claude/settings.json` with the hooks above, `agent: "architect-pm"` as default, permissions allowlist for safe tools.
4. Create `.claude/loop.md` with the maintenance prompt (see below).
5. Set workspace spend limit in Claude Console: $200/mo hard cap.
6. Set monthly usage credit limit on subscription if applicable: `/usage-credits`.
7. Open one test issue: "Draft ADR 0007 deferring user-authored categories explicitly." Watch Architect-PM handle it. Review before merge.

A starter `loop.md`:

```markdown
Architect-PM maintenance loop. Run only the following, in order:

1. Continue any unfinished work from the current conversation.
2. For each open PR opened by an agent: check Reviewer comments. If straightforward
   to address, address and re-request review. If contentious, comment "needs human
   judgment" and stop on that PR.
3. If DRAFT.md has open questions older than 14 days, draft a one-paragraph
   proposal for each. Do NOT update STABLE.md.
4. Cleanup: typo fixes, dead-link checks, formatting.

You may NOT:
- Push to remote.
- Edit STABLE.md without an accompanying ADR.
- Add new dependencies.
- Begin work on issues marked needs-human-input.
- Initiate work on items in BACKLOG.md.
- Override any rule in AGENTS.md.

If unsure whether something fits these rules, stop and write a note to DRAFT.md
under "Notes for the next human." Do not proceed.
```

### Day 2-7 — Mode B with one-week ramp

Use the agents during waking hours only. Watch them. Build trust in the boundaries.

- Dispatch developer subagent via `@claude implement #N` in GitHub issues, one at a time.
- Reviewer fires on every PR via GitHub Action.
- Architect-PM works in main session, drafts ADRs, creates issues.
- Do NOT enable agent view background sessions yet.
- Do NOT enable Routines yet.
- Track: which subagent failed how, which hook fired, where context bloated.

End-of-week-1 checkpoint: review spend, review what worked, decide whether to expand.

### Day 8-14 — Cautious Mode C ramp

- Enable `claude agents` background mode for the Architect-PM during the work day.
- Add a single Routine: `pull_request.opened` → reviewer subagent. Runs in the cloud, doesn't depend on the laptop.
- `loop.md` runs only when the user explicitly types `/loop 30m` at the end of the day, on a session pinned with `Ctrl+T`. Do not enable indefinite loops yet.

End-of-week-2 checkpoint: did anything embarrassing get committed? Did the budget go where you expected? Adjust.

### Day 15-30 — Mode C with bounded autonomy

- Enable one durable Routine: nightly (cloud-hosted) scheduled run of the `loop.md` maintenance prompt, runs from 11pm-6am local. Configure it to run a one-off cleanup-and-summarize pass, then exit.
- Add a Routine for `pull_request.synchronize` to re-run the reviewer subagent when PRs get pushed updates.
- Add monitoring: a `claude agents --json` cron job (or a tiny script) that emails the user a daily summary of what ran overnight.

End-of-month checkpoint: total spend, time saved, embarrassments, near-misses. Decide whether to ramp further.

### After day 30 — only on demonstrated need

- Bring in `agent teams` for specific tasks where the parallel-perspective payoff is clear (e.g., review a major ADR from UX, perf, and conviction angles in parallel). Always ad hoc, never as everyday architecture.
- Bring in the UX subagent once there's a wireframe.
- Bring in a true Tester subagent if a class of bugs starts slipping past the Reviewer.

---

## What we'd defer or NOT build

Honest list of things the brief touches on that the research says don't pay off (yet):

- **Five separate persistent agents talking to each other.** Documented to fail (MAST, Cognition, Anthropic's own multi-agent paper). Five *subagent definitions* serving one supervisor is the equivalent that works.
- **Agent debate/consensus voting** as the everyday architecture. Token-burning, marginal gains, fragile. Ad-hoc only.
- **Devin or Devin-like fully-autonomous products.** Independent eval shows ~15% real-world success rate, and Claude Code does everything Devin claims at lower cost with better integration to the user's existing workflow.
- **CrewAI / AutoGen / LangGraph for whetstone.** All are reach-for-the-right-tool propositions — and for a solo personal project on Claude Code, the right tool is Claude Code's own primitives.
- **A separate orchestrator (Temporal / Prefect / cron-on-VM).** GitHub + Routines + Claude Code handle whetstone's scale entirely.
- **`bypassPermissions` mode in background agents.** Loss-of-supervisor at the moment of highest risk. Worth the friction of permission prompts.
- **OpenHands or self-hosted OSS alternatives**, *for now.* Revisit only if the user later wants 24/7 hosted agents on the Azure VM without burning subscription quota.
- **Indefinite `/loop`** with no human checkpoint. The 7-day auto-expiry is a feature, not a bug. Let it expire and re-create deliberately.
- **Mode C on day 1.** The ramp to Mode C must include a Mode-B-with-eyes-on week first. The Devin lesson: hands-off autonomy promises more than it delivers.

---

## Failure-mode playbook

For each failure mode whetstone is most exposed to, what to watch for and how to recover:

### FM-1.1 Step repetition / FM-1.5 unaware of stopping conditions

**Watch for:** Architect-PM keeps "polishing" the same ADR draft past three iterations. Developer reverts and re-applies the same change.

**Detect early:** Status line showing turn count per session. Routine spend alerts (sudden 2× the daily average).

**Recover:** `Esc` to interrupt. `/clear` and restart with a more specific prompt. Reduce `maxTurns` for that subagent.

### FM-3.3 Resource mismanagement (cost runaway)

**Watch for:** Claude Console spend graph jumps. Daily `/usage` reports up sharply vs prior week.

**Detect early:** Workspace spend limit (Anthropic-enforced hard cap, set on day 1). Subscription `/usage-credits` monthly cap.

**Recover:** Workspace limit stops it. Investigate `claude agents` for runaway sessions; `Ctrl+X` twice to stop and delete. Add `--max-turns` to the offending subagent.

### FM-3.2 Incorrect result / hallucinated capability

**Watch for:** PR description says "added test coverage" but no test file changes. Commit says "fixed bug X" but the bug reproduces.

**Detect early:** Reviewer subagent runs on every PR; should flag this. Stop hook running `dotnet test --no-build` blocks "done" declaration until tests pass.

**Recover:** Reject PR. Human comments specific evidence required. Re-invoke developer with the evidence requirement explicit.

### FM-4.1 Suboptimal agent topology (too many agents)

**Watch for:** Spend climbing without proportional output. User can't easily say what each agent did today.

**Detect early:** Weekly retrospective. Track issues-closed per dollar spent.

**Recover:** Disable subagents one at a time. Measure. Add back only the ones whose absence is felt.

### FM-2.3 Information distortion (when agent teams are used)

**Watch for:** Two teammates report contradictory findings on the same PR.

**Detect early:** Lead agent should synthesize; if it just relays, ask "summarize the disagreement." Often the disagreement is artifact of context, not substance.

**Recover:** Drop to a single agent on that task. Ad-hoc multi-agent should be a tool, not a default.

### Polluted main branch

**Watch for:** Test failures on main after agent merges.

**Detect early:** CI pipeline (already in STABLE.md → CI). Pre-commit `dotnet format`. Mandatory human review (already in AGENTS.md).

**Recover:** Standard `git revert`. Increase the Reviewer subagent's strictness; add a hook on `Stop` that requires CI pass before declaring done.

### Hallucinated commit / "I did it" without doing it

**Watch for:** Session declares completion; `git status` shows no changes; or commit succeeds but contents are wrong.

**Detect early:** Best-practice: agents must show evidence (file diff snippet, command output). Stop hook validates *something* changed.

**Recover:** Roll back. Restart with a more specific prompt. If recurring, the agent definition's system prompt likely needs `"After every change, run `git diff` and include the relevant section in your response. Do not declare done without showing it."`

### Loss of context across sessions / cannot resume

**Watch for:** After `--resume` the agent seems amnesiac about decisions made.

**Detect early:** Note-taking pattern: agents write durable notes to `decisions/`, `DRAFT.md`, or `.claude/agent-memory/<name>/MEMORY.md`. The repo, not the conversation, is the source of truth.

**Recover:** `--resume` doesn't restore teammates in agent teams (a documented limitation). For single-session workflows, point the resumed session at the relevant note files explicitly.

---

## Bibliography

Anthropic. *Create custom subagents*. Claude Code documentation, June 2026. https://code.claude.com/docs/en/sub-agents

Anthropic. *Orchestrate teams of Claude Code sessions* (Agent teams, experimental). Claude Code documentation, June 2026. https://code.claude.com/docs/en/agent-teams

Anthropic. *Manage multiple agents with agent view*. Claude Code documentation, June 2026. https://code.claude.com/docs/en/agent-view

Anthropic. *Run prompts on a schedule* (`/loop`, ScheduleWakeup, cron tools). Claude Code documentation, June 2026. https://code.claude.com/docs/en/scheduled-tasks

Anthropic. *Automate work with routines* (cloud-hosted scheduled and event-triggered sessions). Claude Code documentation, June 2026. https://code.claude.com/docs/en/routines

Anthropic. *Claude Code GitHub Actions*. Claude Code documentation, June 2026. https://code.claude.com/docs/en/github-actions

Anthropic. *Agent SDK overview*. Claude Code documentation, June 2026. https://code.claude.com/docs/en/agent-sdk/overview

Anthropic. *Run agents in parallel* (subagents vs agent view vs agent teams vs dynamic workflows comparison). Claude Code documentation, June 2026. https://code.claude.com/docs/en/agents

Anthropic. *Best practices for Claude Code*. Claude Code documentation, June 2026. https://code.claude.com/docs/en/best-practices

Anthropic. *Manage costs effectively* (per-developer spend benchmarks, agent team token cost guidance). Claude Code documentation, June 2026. https://code.claude.com/docs/en/costs

Anthropic. *Model pricing*. Claude Platform documentation, June 2026. https://platform.claude.com/docs/en/about-claude/pricing

Anthropic. *How we built our multi-agent research system*. Anthropic Engineering blog, 2025. https://www.anthropic.com/engineering/built-multi-agent-research-system — orchestrator-worker pattern; ~15× tokens vs chat; 90.2% gain over single Opus; early agent misbehaviors (50 subagents for simple queries, SEO content farm bias).

Anthropic. *Effective context engineering for AI agents*. Anthropic Engineering blog, September 29, 2025. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — context as finite resource, "context rot," just-in-time retrieval, compaction, structured note-taking.

Cemri, M. et al. *Why Do Multi-Agent LLM Systems Fail?* arXiv:2503.13657, 2025. https://arxiv.org/abs/2503.13657 — MAST taxonomy of 14 failure modes across 7 popular MAS frameworks (ChatDev, MetaGPT, Magentic-One, AutoGen, etc.), 1600+ annotated traces, κ=0.88 inter-annotator agreement.

Cognition Labs. *Don't Build Multi-Agents*. Cognition blog. https://cognition.ai/blog/dont-build-multi-agents — context-sharing principles; argues against OpenAI Swarm and Microsoft AutoGen patterns; the Flappy Bird example; recommends single-threaded linear agents with compression-based summarization.

Cognition Labs. *Cognition blog* (Devin year-in-review, SWE-1.x model family). https://cognition.ai/blog — Devin's pivot from autonomous-only to mixed mode; SWE-1.5 (Oct 2025) and SWE-1.6 (early 2026) models; Claude Sonnet 4.5 integration.

Answer.AI. *Devin: Looking Back on a Month with the Famous Autonomous AI Engineer*. Answer.AI blog, January 8, 2025. https://www.answer.ai/posts/2025-01-08-devin.html — Independent eval: 14/20 tasks failed, ~15% real-world success rate; tunnel vision, false confidence, over-engineering, unpredictability as top failure modes.

GitHub. *About GitHub Copilot coding agent*. GitHub Docs, 2026. https://docs.github.com/en/copilot/concepts/agents/about-coding-agent — 59-minute timeout, single-repo-per-session, one-branch-one-PR, premium request model.

LangChain. *Multi-agent systems with LangGraph*. LangGraph documentation. https://langchain-ai.github.io/langgraph/concepts/multi_agent/ — StateGraph, nodes/edges/state, checkpointing, native human-in-the-loop.

Microsoft. *AutoGen documentation*. https://microsoft.github.io/autogen/stable/ — layered architecture post-rewrite: Core (event-driven), AgentChat (conversational), Extensions, Studio (no-code UI).

CrewAI. *CrewAI introduction*. https://docs.crewai.com/introduction — Crews (collaborative agents) + Flows (state and control flow); production guidance requires both.

OpenHands. *OpenHands documentation*. https://docs.openhands.dev/ — Agent Canvas, Cloud, Enterprise, Software Agent SDK; MIT license for core, source-available enterprise.

Devin (Cognition AI). *Pricing*. https://devin.ai/pricing — June 2026 tiers: Free, Pro $20/mo, Max $200/mo, Teams $80/mo + $40/seat, Enterprise custom.

Aider. *Modes*. Aider documentation. https://aider.chat/docs/usage/modes.html — architect/editor two-step pipeline; ask/code mode alternative.

---

## Limits of this review

**What was searched well:** Anthropic-first-party documentation (subagents, agent teams, agent view, Routines, GitHub Actions, Agent SDK, pricing, costs, best practices, context engineering). Cognition's published positions on multi-agents and Devin's evolution. The MAST academic taxonomy. Devin's public pricing and one independent third-party evaluation. GitHub Copilot coding agent's docs. AutoGen, CrewAI, LangGraph official documentation. OpenHands docs and active GitHub issues for failure-mode signal.

**What relied on training data:** General descriptions of failure modes observed in the wild but not cited to a specific 2025-2026 source (e.g., "users complain about X on r/LocalLLaMA" — Reddit access was blocked during this research, so those signals come from prior knowledge rather than fresh web evidence). Devin's success rate uses one well-sourced eval (Answer.AI, January 2025) plus general post-2025 industry signal; later evals may show different numbers as Cognition iterated.

**Where this might already be stale:**

- Anthropic ships new Claude Code primitives roughly monthly. Agent teams was "experimental" in June 2026; it may be GA by the time this is read.
- Devin's success rate may have improved meaningfully on SWE-1.6 (early 2026); the Answer.AI eval was January 2025 against an earlier model. The price drop (5×$500→$20) suggests Cognition repositioned rather than reliably hit the autonomy goal — but a later eval may overturn this.
- The cost numbers in **Topic 5** are calibrated to June 2026 pricing. Opus dropped 3× in price between Opus 4 and Opus 4.5; a similar shift in any direction would change the calculus.
- Routines is "research preview." Beta header `experimental-cc-routine-2026-04-01` may change with breaking-change semantics.
- GitHub Copilot's coding agent pricing model uses "premium requests" — the per-action cost has shifted at least twice in the last year; check current figures before quoting to anyone.
- Agent SDK introduces a separate "Agent SDK credit" allowance on June 15, 2026; effects on solo-developer plan economics are not yet measured.

**Where evidence is genuinely thin:**

- **Long-term reliability of any agent team in autonomous mode for solo personal projects.** Most case studies are from companies with one or more humans actively babysitting. The "while you sleep" reliability target is, honestly, aspirational across the field. Plan accordingly.
- **Real cost of agent teams sustained over weeks** (vs the per-task numbers Anthropic publishes). The 7× multiplier is a snapshot; usage patterns matter.
- **How well the Reviewer subagent pattern catches conviction violations specific to a project's STABLE.md.** This is whetstone-specific and has to be measured in practice.

Final note: this document is intentionally **opinionated where the user asked for opinion and explicit about ambiguity where it exists**. The user's preference for strong recommendations is honored; the user's preference for honest calibration is too. When the recommendations and the user's instincts disagree, the recommendations are mine, and the decision is the user's.
