# ADR 0009 — Code review SPEC; Architect owns code review (no sixth role)

**Date:** 2026-06-09
**Status:** Accepted

## Context

After deploying the five-role agent team (ADR 0007), the user identified a real gap: code review's *technical* dimension (naming, async patterns, EF Core anti-patterns, MAUI lifecycle pitfalls) had no explicit owner. COWORK.md assigned PR review responsibilities by concern (Architect = design, PM = scope, Tester = behavior, UX = wireframe fit), but "is this *code* good?" was implicit at best.

The user proposed adding a sixth role — Code Reviewer — and, more importantly, observed that without a concrete review SPEC, any reviewer (sixth role or otherwise) would fall back to pattern-matching from training data. Generic OSS conventions don't catch MAUI/Blazor/EF-Core-specific bugs; worse, they prescribe patterns (helpers, DRY, defensive validation) that fight whetstone's locked anti-rules.

[AGENT_TEAM_RESEARCH.md](../AGENT_TEAM_RESEARCH.md) already argued against adding roles. Each new role multiplies coordination cost and adds inter-agent failure modes (MAST taxonomy FM-2.x). The research recommendation: extend an existing role rather than add one.

A separate research pass produced [`REVIEW_NOTES.md`](../REVIEW_NOTES.md): ~4,400 words of stack-specific review heuristics grounded in Microsoft Learn, EF Core docs, the .NET team blogs, Anthropic API docs, and the Whisper.NET issue tracker. The notes surface real, verifiable, stack-specific patterns that a generic review would miss (DateTimeOffset client evaluation in SQLite; StateHasChanged inside lifecycle methods; HttpClient lifetime; Whisper.NET model loading; etc.).

## Decision

1. **Write `REVIEW_SPEC.md`** at the repo root — the concrete code-review checklist for whetstone, built on top of STABLE.md's engineering principles and the stack-specific research in REVIEW_NOTES.md.
2. **Architect owns code review.** Architect's existing responsibility for "PR design correctness" is expanded to include code-level review against REVIEW_SPEC.md.
3. **No sixth role.** Code review and design review are deeply connected — both ask "does this fit how we build things?" Splitting them creates a seam at the most likely point of reviewer disagreement.
4. **REVIEW_NOTES.md committed as a permanent reference doc.** Treated like RESEARCH.md and AGENT_TEAM_RESEARCH.md — frozen background that informs but does not replace the SPEC.
5. **Same review-order discipline in the SPEC**: gates (conviction / scope / real-seam / same-commit) checked first; stack-critical patterns next; integration-specific last; style/idiom decisions delegated to `dotnet format`.
6. **The SPEC is opinionated about what NOT to review** — explicitly enumerates the generic-OSS review patterns whetstone rejects (DRY suggestions on three lines, defensive null checks beyond boundaries, helper extractions without responsibility, future-proofing speculation). This is as load-bearing as the reject patterns.

## Alternatives considered

- **Sixth role (Code Reviewer)**: rejected. The research argued against adding roles in general. Code-level and design-level review share too much context to split cleanly. Adding a role would mean two reviewers most likely to disagree on the same PR, and the disagreement-with-Architect failure mode is hard to mitigate. Could be reconsidered if Architect proves overloaded once code flows.
- **No SPEC, rely on Architect's judgment**: rejected. The user correctly identified that any reviewer without a concrete checklist pattern-matches from training data, and that training data is generic OSS practice that doesn't fit whetstone's locked principles.
- **SPEC written from training-data knowledge alone**: rejected. The user explicitly requested research-grounded SPEC because the alternative is hallucinated heuristics with citations that don't exist.
- **SPEC as a section of STABLE.md**: considered. Rejected because the SPEC is operational (used in review sessions) rather than a locked architecture/methodology decision. Lives at the same level as TEST_PLAN.md, WIREFRAMES.md, COWORK.md — operational manuals owned by specific roles.
- **Merge Tester's PR-behavior review into Architect's expanded review scope**: rejected. Tester's job (verify user-visible behavior) is genuinely different from code-level review (verify the code is right). Keep separate.
- **Have the future Architect session write the SPEC as its first task**: rejected by user. The SPEC is foundational; written from the design conversation's full context, it is sharper than a cold-start Architect could produce on its own.

## Consequences

**Positive:**
- Code review now has a concrete, citable checklist instead of "the Architect's taste."
- The SPEC is grounded in cited sources (Microsoft Learn, EF Core docs, Anthropic docs, Whisper.NET issue tracker) rather than recalled best practices.
- Developer can self-review against the SPEC before opening a PR — reduces review-cycle waste.
- Top-15 quick-reference at the head of the SPEC enables fast review for small PRs without requiring a full walk of the document.
- The SPEC's "do NOT review" section explicitly stops Architect from drifting into generic-OSS pattern-matching.
- Architect's role expansion is small (code review is adjacent to design review) and avoids the inter-agent failure modes of a sixth role.
- Stack-specific reject patterns (DateTimeOffset in SQLite; StateHasChanged in lifecycle methods; Whisper model loading) will catch bugs that wouldn't surface until production otherwise.

**Negative / accepted risk:**
- Architect now has more on its plate. If review volume becomes burdensome, the sixth-role option remains available; ADR can be superseded.
- The SPEC is necessarily incomplete — any code-review checklist eventually meets a PR it doesn't cover. Architect is still required to use judgment; the SPEC is scaffolding, not a substitute.
- Some sections (especially §12 Whisper) rest on thin evidence per REVIEW_NOTES.md's own caveat. Reviewers should treat Whisper-touching diffs as needing extra scrutiny.
- Specific cited numbers (Haiku 4.5 prompt-cache minimum 4,096 tokens; CA rule IDs) may rot within months. Revisit triggers in the SPEC document this.
- "Top 15" quick-reference might be used as a substitute for the full SPEC even on substantial PRs — a discipline failure, not a SPEC failure.

## Revisit triggers

- After 4 weeks of active code review against the SPEC: which sections fire often, which never? Trim or expand.
- A class of bug surfaces in production that the SPEC failed to catch → add the pattern to the SPEC.
- Architect proves overloaded (review queue grows; PR cycle time stretches) → reconsider sixth role; ADR can be superseded.
- A locked dependency changes (e.g., `Microsoft.Extensions.Http` enters approved-deps) → update §11.
- Anthropic pricing or caching minimums change → update §11.
- Whisper.NET / Whisper-in-MAUI integration matures (better OSS, fewer issue-tracker reports) → soften §12 caveats.
- An anti-rule in STABLE.md is relaxed → remove the corresponding reject pattern from the SPEC.
- The SPEC's "do NOT review" list gets challenged by a real situation → discuss, possibly amend with caveat.
