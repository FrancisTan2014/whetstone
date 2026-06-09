# ADR 0007 — Five-role agent team with human as hub

**Date:** 2026-06-09
**Status:** Accepted

## Context

The user wants whetstone built by an agent team rather than purely by themselves. They named five roles (Architect, PM, Developer, Tester, UX) and initially asked for a self-iterating autonomous team (Mode C).

[`AGENT_TEAM_RESEARCH.md`](../AGENT_TEAM_RESEARCH.md) surveyed the multi-agent coding landscape in early 2026 and surfaced three findings that shape this decision:

1. **Cognition's "Don't Build Multi-Agents"** (the company that built Devin) explicitly argues against peer-to-peer multi-agent collaboration for code. Single-threaded agents with disciplined delegation outperform conversational multi-agent setups.
2. **MAST taxonomy** (Cemri et al. 2025, arXiv:2503.13657) catalogued 14 failure modes in multi-agent systems across 1,600+ traces, with specification failures, inter-agent communication failures, and topology mistakes dominant.
3. **Mode C (autonomous between check-ins)** requires Routines (personal Anthropic plan) or GitHub Actions (Anthropic API key in repo secrets). Neither runs from the user's work environment.

The user then changed their mind toward a five-session interactive model: five terminals, five role-specific Claude sessions, the user orchestrating between them. This is achievable today in the work environment with no infrastructure setup beyond agent definition files.

The user also requested specific role separations the research argued against — particularly Architect vs PM as separate roles — and asked for Tester and UX to be active even before code exists.

## Decision

1. **Five distinct agent definitions** in `.claude/agents/`: `architect.md`, `pm.md`, `developer.md`, `tester.md`, `ux-designer.md`. Each runs in its own Claude Code session, started with `claude --agent <name>`.
2. **The human is the orchestrator.** Sessions do not communicate directly with each other (no `SendMessage`, no agent teams). Coordination happens through:
   - GitHub Issues and PRs as persistent shared state.
   - File system (each role owns specific files; others read).
   - The human, who switches between sessions and resolves conflicts.
3. **Architect and PM are kept separate** (against the research's recommendation), with explicit tensioned scopes: Architect owns STABLE.md + decisions/ (design correctness); PM owns DRAFT.md + BACKLOG.md + issues (scope and prioritization). The tension is intentional; the human is the tiebreaker.
4. **Tester and UX are active in the design phase**: Tester drafts TEST_PLAN.md (v1 test strategy); UX drafts WIREFRAMES.md (v1 screen inventory). Both have real work that informs implementation, not idle placeholder roles.
5. **File-edit boundaries are strict and enforced by convention**: each file has exactly one owning role; others may read. Cross-boundary requests go through comments (on issues, in DRAFT.md, on PRs).
6. **Hooks enforce hard rules**: `git push`, `gh pr merge`, dependency additions without allowlist, destructive git operations, hook-skipping flags — all blocked at the tool layer in `.claude/settings.json` so they fail loudly rather than slip through.
7. **The human merges**: agents may approve PRs; only the human clicks merge. Same logic as the "do not push to remote" rule — irreversible-ish actions affecting shared state stay with the human.
8. **Mode B today, Mode C later**: the five-session interactive setup is Mode B per the research. Autonomous deployment (Routines, GitHub Actions, background agents) is deferred to a future phase once the interactive flow has been used and trusted for at least two weeks.

## Alternatives considered

- **Two roles only** (Architect-PM merged + Developer, per research recommendation): rejected by the user. Their reasoning — they want Architect and PM as separate tensioned voices — is operationally sound for a solo project where the user is the tiebreaker.
- **Single-session-with-subagents (also per research)**: rejected because the user wants distinct terminals with role-specific context, not delegation from one main session. Functionally similar to subagents but with cleaner separation of context.
- **Mode C autonomous from day 1**: rejected because (a) it requires infrastructure outside the work environment, (b) the research's failure-mode catalog warns against unsupervised autonomy on novel code work, and (c) it premature-optimizes before the interactive flow is trusted.
- **Devin or similar third-party autonomous agent**: rejected per AGENT_TEAM_RESEARCH.md — ~15% real-world success rate per Answer.AI eval, and Claude Code natively covers everything Devin claims.
- **CrewAI / AutoGen / LangGraph / Temporal**: rejected per AGENT_TEAM_RESEARCH.md — Anthropic-native stack covers a solo personal project; additional frameworks add complexity without payoff.
- **Tester and UX dormant until code exists**: rejected. Both can do meaningful design-phase work (TEST_PLAN.md and WIREFRAMES.md) that informs implementation. Idle agents are wasted overhead; working agents amortize their setup cost.

## Consequences

**Positive:**
- Five named roles match the user's mental model and make orchestration intuitive.
- Strict file-edit boundaries make the team's working surface predictable; no role can quietly clobber another's work.
- Hooks enforce the highest-stakes rules at the tool layer; agents cannot "forget" them.
- Architect-PM tension is preserved (the research-endorsed merge would have lost it).
- Tester and UX produce useful design-phase artifacts that aren't blocked by the absence of code.
- Mode B is the right starting place per the research — bounded autonomy, human as supervisor, fast feedback on what works.
- Same agent definitions become Mode C agents later (Routines/GitHub Actions can target them) without redesign.

**Negative / accepted risk:**
- Five concurrent sessions cost ~5× the tokens of a single session. Acceptable in the work environment with effectively unbounded tokens; would be expensive on personal billing.
- Strict role boundaries can create friction when a small cross-boundary edit would be faster than a comment. The friction is the feature — it forces conviction-touching changes through the right reviewer.
- The user orchestrates manually. There is no automation here; if the user does not switch sessions, nothing happens. This is honest; the research warns that pretending otherwise (Mode C from day 1) fails.
- Architect vs PM tension can produce stuck disagreements. Mitigated by the two-iteration escalation rule (see [COWORK.md](../COWORK.md) → conflict resolution).
- "Information distortion" between role contexts is a documented failure mode (MAST FM-2.3). Mitigation: persistent state lives in GitHub and the file system, not in any session's memory. Every role reads the same artifacts.

## Revisit triggers

- After 2 weeks of interactive use: are Architect and PM producing distinct value, or is the tension just friction? If the latter, consider merging per the research.
- After 4 weeks: is any role idle most of the time? Consider removing or merging into another role.
- When ready for Phase 2 (autonomous deployment): write a new ADR scoping which sessions move to background-mode, Routines, or GitHub Actions. The agent definitions should not need rewriting; only the deployment model changes.
- If cost concerns ever apply (e.g., the user moves work off the work environment): re-evaluate the five-session approach against the research's two-role recommendation.
- If a class of failure surfaces that this setup cannot prevent: revisit the hooks and the role definitions.
