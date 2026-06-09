# TEST_PLAN.md

The v1 black-box test strategy for whetstone. Owned by Tester (per [COWORK.md](./COWORK.md)).

**Status:** stub. Tester drafts this document during the design phase, then maintains it as v1 implementation lands.

---

## What this document is

A user-perspective test plan. What user-visible behaviors must work for v1 to ship. What edge cases matter. How to verify each behavior end-to-end without inspecting internal state.

This document does NOT cover:

- Unit tests on pure logic (those are Developer's responsibility per [STABLE.md → Tests](./STABLE.md#tests); xUnit + FluentAssertions in source).
- LLM grading accuracy on specific prompts (calibration concern, owned by human, surfaces over weeks of real use).
- Whisper transcription quality on specific accents (same reason).
- Pronunciation scoring (out of v1 per [ADR 0006](./decisions/0006-voice-first-class.md)).

---

## How to fill this in

When Tester begins drafting, the document should grow to include:

1. **Test inventory** — every user-visible behavior in [STABLE.md → Scope (v1)](./STABLE.md#scope-v1), one row per behavior, with a verification approach for each.
2. **Smoke test script** — the short walkthrough that hits the daily routine end-to-end. Run before/after every meaningful change once code exists.
3. **Edge cases worth surfacing now** — situations that would be hard to discover during implementation. Example: what happens on a day with no due revisits? What happens when LLM budget is exhausted mid-routine? What happens when Whisper fails to transcribe?
4. **Bug-report template** — the standard structure Tester uses when filing issues. Title, reproduction, expected, actual, environment, labels.

---

## (Tester: begin here)

_Document body starts below. The above is preamble for any agent reading cold._
