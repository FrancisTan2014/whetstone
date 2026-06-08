# ADR 0003 — Learning methodology

**Date:** 2026-06-08
**Status:** Accepted (draft shape — expected to evolve from real use)
**Supersedes:** Parts of ADR 0001 (recall algorithm)

## Context

The original ADR 0001 picked SM-2 as the universal recall algorithm and a single recall queue per user. After re-examination, this collapsed two different problems into one:

- **Memorization** (verbatim retention of passages, vocabulary) — SRS is well-suited.
- **Understanding** (stories, concepts, mechanisms) — SRS is the wrong tool. Understanding doesn't decay in clean exponential curves; it integrates with neighbors or it doesn't.

Treating both with SM-2 risks turning whetstone into a flashcard app — exactly the framing the user wanted to avoid. The user's stated mental model is "guide-with-conviction, not sandbox" with strong defaults per material type.

Additionally: self-grading is empirically unreliable (Anki users either game it or sandbag it). With LLM access now ubiquitous and cheap, LLM-judged grading produces meaningfully better signal.

## Decision

1. **Five default categories**, each with its own template, recall algorithm, and grading style:
   - Literary narrative → diminishing revisits (1d, 7d, 30d, 90d, done)
   - Recitation → FSRS
   - Vocabulary → FSRS
   - Concept/mechanism → linked surfacing (graph-driven, not clock-driven)
   - Reflection → no recall
2. **LLM grading by default** (Pattern A: hard daily budget). Default $0.25/day. Self-grade fallback when budget exhausts.
3. **Four grades** (Forgot / Partial / Solid / Stronger) instead of three, to capture the case where recall improves on the original.
4. **`IGrader` interface** introduced as the second real seam (alongside `INoteStore`). Implementations: `AnthropicGrader` (v1), `SelfGrader` (always available), `OllamaGrader` (deferred to v1.5/v2 for desktop-local LLM).
5. **Five locked convictions** documented as the philosophy layer. Users cannot disable these.
6. **Templates per category, not per subject**, with admin extensibility deferred to a later phase.

## Alternatives considered

- **Single SM-2 queue (original ADR 0001 plan)**: rejected because it conflates memorization and understanding.
- **Self-grading only**: rejected because of known reliability issues with self-assessment.
- **LLM grading without budget cap**: rejected because runaway cost is the user's primary concern.
- **Local LLM from v1 (Ollama desktop, mobile separately)**: rejected because mobile local LLM is platform-fragmented and contradicts the MAUI cross-platform thesis. Path 2 chosen instead — `IGrader` abstraction allows local-LLM addition later without rewrite.
- **Pre-generated grading rubrics (Pattern B)**: rejected because static rubrics fail on valid alternative wordings, producing user frustration.
- **More than five categories**: deferred. Test with five, add a sixth (likely "technical reading") only when real material doesn't fit existing categories.
- **No reflection category**: drafted as included for completeness. May be removed if it dilutes the conviction.

## Consequences

**Positive:**
- The app stops pretending all material is the same. Each category gets a fit-for-purpose loop.
- LLM grading raises signal quality on recall — the user gets feedback that resembles a teacher, not a checkbox.
- `IGrader` seam preserves option value: local LLM is a future toggle, not a rewrite.
- Cost is bounded and visible. No surprise bills.
- Convictions are explicit — future feature decisions have a touchstone.

**Negative / accepted risk:**
- Offline use is broken. No network → no grading → loop incomplete. User accepts this trade-off; mobile usage on subway-without-signal is sacrificed.
- API key + bill required from first run. Setup friction.
- Steady-state cost ~$3-10/month. User has acknowledged.
- More implementation complexity than single SM-2: four distinct algorithms, interleaving logic, per-category state. Estimated +1-2 weekends of work vs original v1 scope.
- Grading prompt engineering is a real and ongoing design task. The prompts will need iteration based on observed grading quality.
- Schema is larger than originally planned (category, original-answer, spend log, per-category algorithm state).

## Revisit triggers

- Cost runs persistently below $0.10/day → lower the default cap to reduce setup friction.
- Cost hits the daily cap >50% of days → user is using app harder than expected; consider raising cap or showing usage trends.
- Local LLM viability improves on mobile platforms → revisit Path 2 → Path 3 (local-only) consideration.
- One or more categories goes unused after 4 weeks of daily use → remove or merge.
- A type of material appears that fits no category → add a sixth.
- Convictions get bent or worked around in real use → either the convictions are wrong, or the implementation is. Investigate.
