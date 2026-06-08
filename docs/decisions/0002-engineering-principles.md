# ADR 0002 — Engineering principles

**Date:** 2026-06-08
**Status:** Accepted

## Context

A personal app built solo carries different risks than a team product:

- **Over-engineering is the dominant failure.** Patterns intended for team coordination (mediators, repositories, layered architecture) add maintenance burden without paying for themselves at solo-scale.
- **Under-engineering is also possible.** Skipping seams that will *actually* change (storage swap to cloud) creates rewrites later.
- **Testing has a maintenance cost.** Every test is forever; tests against UI or persistence break frequently and erode trust.
- **CI vs pre-commit overlap.** Both run the same checks; the cost is doubled friction.

This ADR captures the trade-offs explicitly so they can be revisited with evidence after v1 ships.

## Decision

See [`docs/05-engineering-principles.md`](../05-engineering-principles.md) for the full ruleset. Headline choices:

1. **Interfaces only at real seams.** `INoteStore` is the only interface justified by current requirements. No `IService` for everything.
2. **Unit tests on pure logic only.** `SrsEngine` and `RoutineGenerator` are tested exhaustively. No tests on SQLite, UI, or MAUI bootstrap.
3. **Microsoft C# conventions, enforced by `dotnet format`.** No custom style.
4. **Nullable reference types on, warnings as errors from day one.** Catch null bugs before they accumulate.
5. **Pre-commit hook formats only; CI runs tests.** Avoids per-commit test latency while keeping a hard safety net.
6. **Direct push to `main`, no PR ceremony.** Solo workflow. CI is the safety net.
7. **Conventional Commits.** Enables future auto-changelog if wanted, otherwise harmless discipline.
8. **ADRs for every decision worth re-litigating.** Append-only; superseded by new ADRs.

## Alternatives considered

- **Full enterprise C# (interface per service, repository pattern, CQRS, Result<T>)**: Rejected — ceremony without payoff at solo-scale.
- **No tests at all**: Rejected — SM-2 has too many edge cases (overdue, ease floor, lapses) to debug in-app.
- **Full test pyramid (unit + integration + E2E)**: Rejected — UI/E2E tests on Blazor WebAssembly are slow and brittle for a single-user app.
- **Pre-commit hook runs everything**: Rejected — tests in a hook will eventually be bypassed with `--no-verify`, eroding the safety net.

## Consequences

**Positive:**
- Velocity stays high. No ceremony tax per feature.
- The two pieces of code that *would* be hardest to debug in-app (SRS + routine) are exhaustively tested.
- CI is the single source of truth for "did this break."
- Storage swap to cloud (v2) is trivial because `INoteStore` already exists.

**Negative / accepted risk:**
- No safety net against SQLite schema bugs, UI regressions, or MAUI bootstrap issues — those will surface as bugs in daily use. Acceptable: the user is also the only user.
- Rules may need to evolve. Anti-rules list (in principles doc) is most likely to need exceptions.

## Revisit when

After v1 has been used daily for ≥ 2 weeks. Concrete trigger: a bug class appears that this ruleset failed to prevent.
