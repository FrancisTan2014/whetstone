# ADR 0004 — Pause mechanism

**Date:** 2026-06-08
**Status:** Accepted

## Context

A learning app that enforces daily encounter faces a tension: real life is not uniformly available. Vacations, illness, work crunches, and natural phase-shifts in interest all happen. Without an honest mechanism for declared absence, two failures appear:

1. **Queue explosion.** Items accumulate as "overdue" during silent absence; user returns to a wall of cards that makes daily encounter impossible. This is the most common reason Anki users abandon.
2. **Internalized failure.** Silent skipping trains the user to view themselves as failing, which erodes the daily-ritual habit that Conviction #1 depends on.

The naive response — "drop this card" or "I don't want to do this today" — solves the wrong problem and bleeds the convictions, particularly:
- Conviction #3 (forgetting is data, not failure — drop privatizes the failure).
- Conviction #5 (your past self is the rubric — drop avoids the confrontation).

A better solution must be conviction-aligned: it accepts that the user *will* be absent sometimes, and adjusts the algorithm to support the return, not punish it.

## Decision

Two pause types, both first-class features in v1:

1. **Category pause** — freezes a single category's recall queue; no new-encounter slots offered for that category. Other categories continue. Pause is time-bounded (`paused_until: <date>`) or explicitly indefinite. Resume shifts due dates forward by the pause duration.
2. **Loop pause** — freezes the entire app. All recall + new-encounter slots suppressed. Ritual slot pauses by default; user can opt to keep it. Resume shifts every recall item's `next_surface_date` forward by `pause_duration`. No FSRS recalculation, no lapses recorded, no penalty.

Explicit non-features (rejected with reasoning in [`STABLE.md → Pause mechanism`](../STABLE.md#pause-mechanism)):

- **No item-level pause** — drop-button in disguise; violates Conviction #3.
- **No retroactive pause** — past skipping was skipping.
- **No silent pause** — settings always shows active pause status.

A "decision boundary" framework added to the methodology doc, to be applied to all future feature proposals: features that help the user *avoid* a conviction are rejected; features that help the user *fulfill* a conviction are accepted.

## Alternatives considered

- **No pause; let the queue explode and trust user resilience**: rejected — empirically, this is what makes users quit (cf. Anki abandonment patterns).
- **Drop-this-item button**: rejected — violates Conviction #3, trains avoidance, privatizes failure.
- **Defer pause to v2**: considered. Rejected because the first time a user experiences the "wall on return" failure is often the time they abandon. The cost to ship pause in v1 is modest (~1 day of work: pause state in schema, algorithm check, settings UI). The cost of *not* shipping it could be loss of the user.
- **Auto-pause on detected inactivity**: rejected — magical, removes user agency, violates "no silent pause."
- **Pause with retroactive option**: rejected — pause is a contract the user makes with themselves about the future. Retroactive pause is the user negotiating with the past.

## Consequences

**Positive:**
- The "wall on return" failure mode is eliminated. Returning users walk back into a normal-sized day.
- The convictions are strengthened, not weakened: pause is the honest shrink that Conviction #1 already endorses.
- A decision boundary framework now exists for evaluating future features, preventing repeat conversations like the one that produced this ADR.

**Negative / accepted risk:**
- Adds two schema fields and a small algorithm branch (skip paused categories in interleaving; shift dates on resume).
- Adds settings UI affordances for declaring/resuming pause.
- User could in principle abuse pause to permanently defer learning. This is fundamentally a user-discipline problem the app cannot solve; making pause visible at least makes the avoidance honest with themselves.
- Estimated +1 day of v1 implementation work.

## Revisit triggers

- User uses loop pause more than 25% of available days → either life is genuinely hard, or pause is being used as drop-in-disguise. Conversation, not code, is the response.
- Category pause never used → maybe loop pause is enough; consider simplifying.
- A scenario appears where pause is too coarse (e.g., user wants to pause only the recall queue but keep doing new encounters) → revisit granularity.
