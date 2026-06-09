# whetstone

> Growth through daily discipline.

A personal learning app and knowledge library that turns daily reading, listening, writing, speaking, and re-encounter into a sustainable practice. Built on the principle that **short, daily, joyful practice beats long, sporadic, forced study** — and that growth happens *between* encounters with the same material, not within any single one.

## Status

🛠 **Design phase.** No code exists yet. Decisions and scope are being locked before implementation begins.

## Where to start

- **For humans curious about the project**: read on.
- **For agents (LLMs, Claude Code, etc.) working in this repo**: read [`AGENTS.md`](./AGENTS.md) first.

## The loop

```
read / listen  →  capture  →  re-express (write or speak it back)  →  connect
                                                                          ↓
                                                                 revisit later
```

Every day whetstone produces a routine: a small set of revisits from past encounters and slots for new material across the user's active categories. Once a week, the routine shifts to surface past entries paired with recent ones — meeting your past self with your present mind.

## Repository structure

| File | Purpose |
|---|---|
| [`STABLE.md`](./STABLE.md) | Every locked decision. What whetstone *is*. |
| [`DRAFT.md`](./DRAFT.md) | What's in motion: open questions, next tasks. |
| [`RESEARCH.md`](./RESEARCH.md) | Cognitive learning science literature review informing the design. |
| [`AGENT_TEAM_RESEARCH.md`](./AGENT_TEAM_RESEARCH.md) | Multi-agent coding team research informing the team structure. |
| [`AGENTS.md`](./AGENTS.md) | Spec for AI agents working in this repo (applies to all roles). |
| [`COWORK.md`](./COWORK.md) | Operating manual for the five-role agent team. |
| [`TEST_PLAN.md`](./TEST_PLAN.md) | v1 black-box test strategy (owned by Tester). |
| [`WIREFRAMES.md`](./WIREFRAMES.md) | v1 UI inventory and flows (owned by UX designer). |
| [`BACKLOG.md`](./BACKLOG.md) | Deferred features. |
| [`decisions/`](./decisions/) | Append-only ADR history. |
| [`.claude/agents/`](./.claude/agents/) | Per-role agent definitions (architect, pm, developer, tester, ux-designer). |
