# ADR 0005 — Revisit as meeting past-self; Direction as identity-anchor; mirror response; vocabulary as layer

**Date:** 2026-06-09
**Status:** Accepted
**Supersedes:** Parts of ADR 0003 (the conception of "recall" and the categories' methods)

## Context

After locking the v1 design via ADRs 0001–0004 and the methodology in STABLE.md, two things happened that forced a re-examination:

1. **A cognitive-science literature review** ([`RESEARCH.md`](../RESEARCH.md)) found that several of whetstone's design choices were well-supported by evidence (retrieval practice, FSRS for verbatim material, daily ritual, no-streaks) while others were principled invention without empirical backing (the specific "diminishing revisits" schedule and the unbounded "linked surfacing" for concepts). Most importantly, the literature on identity-based goal-setting (Sheldon & Elliot 1999 self-concordance; Oyserman identity-based motivation) was the strongest support for an addition that was sitting in DRAFT — the "Direction" idea — but had not yet been promoted.
2. **The user pushed back substantively** on the framing that "recall" was the universal verb. The pushback was that for literary narrative and for reflection (diary), the act of meeting one's own past writing is not testing — it is encounter. The user proposed the formulation "you wrote [X] on [Y] — has your mind changed?", which named what the existing design was groping toward.

Additionally, the user identified that requiring full-card authoring for vocabulary was an editing tax that breeds procrastination — exactly the failure mode whetstone is supposed to defend against.

## Decision

1. **Terminology**: replace "recall" with "revisit" throughout STABLE.md and downstream. Revisit is broader than recall and captures the conviction shift below.

2. **Add Conviction #6**: *"Revisit is not testing; it is meeting your past self with your present mind. What we resurface, we resurface to grow from — not to score."* This is the philosophical anchor for differentiating revisit methods per category.

3. **Per-category revisit methods**:
   - **Recitation, Vocabulary, Concept/mechanism** keep grade-based revisit (Forgot / Partial / Solid / Stronger). Material that benefits from retrieval testing per the literature.
   - **Literary narrative, Reflection, Prose-modeling** use **mirror response**: the app surfaces the user's original entry; the user writes again; the LLM produces a paragraph naming the delta — *not* a grade. Material where growth, not retention, is the point.

4. **Promote Direction from DRAFT to STABLE**: per subject, the user writes 1-2 sentences declaring why they are studying it and what success looks like in 6-12 months. The LLM uses this as steering anchor for daily proposals. The user reads it at the start of weekly Echo reviews. Editable any time.

5. **Vocabulary becomes a layer, not a category**: any reading material in any category supports one-tap word capture. LLM generates the card (word, paraphrased meaning, the in-context sentence as example, optional etymological hook). User confirms with one tap or edits. Cards flow into a single FSRS queue. This removes the procrastination-inducing "fill a card" pattern.

6. **Curated v1 materials, locked in code**: 史记 (in order), 滕王阁序 / 洛神赋 / 笠翁对韵, Orwell's *Politics and the English Language* (then other essays in order), CS:APP (a re-read for the user — strongest fit for the revisit framing). Reflection is free. User-authored materials deferred to v2.

7. **Prose-modeling replaces standalone "English-literature" as a category** — its own template (model sentence / what you notice / your rewrite / where you lose the music) and its own revisit method (generative: write a sentence in the same style about something you're thinking today). Animal Farm and novels deferred; essays are the right unit.

8. **Weekly Echo review** every 7th day: replaces the standard routine, surfaces 3-5 past entries paired with recent ones, mirror response. The cleanest operationalization of Conviction #6.

9. **Evidence calibration**: STABLE.md now explicitly notes where choices are research-backed vs principled-invention. Specifically: "diminishing revisits" 1d/7d/30d/90d is principled (extends fuzzy-trace theory of gist memory) but the 90-day cap is arbitrary; "linked surfacing" has no published comparison to clock-based SRS; cross-category interleaving is operational, not retention-backed.

## Alternatives considered

- **Keep "recall" as the universal verb**: rejected. Conflates two genuinely different acts (retrieval testing for facts; encounter with past-self for understanding). The conflation was making whetstone subtly more flashcard-like than the user wanted.
- **Defer Direction to v2**: rejected. The research (Sheldon, Oyserman, Steel's Temporal Motivation Theory) is the strongest empirical support for any single addition we've considered. Shipping without it weakens v1's procrastination defense.
- **Use grade-based revisit for all categories**: rejected. Grading literary engagement collapses Conviction #6 immediately. The mirror response is the right shape.
- **Use mirror response for all categories including recitation/vocab**: rejected. Verbatim retention benefits from the four-grade signal feeding FSRS; mirror response would lose the algorithm's input.
- **User authors full vocabulary cards (original plan)**: rejected. Editing tax is the procrastination vector. LLM-generated cards with one-tap confirm reverses this. Acceptable cost: small chance of LLM-introduced inaccuracy, mitigated by the edit-then-save fallback path.
- **Keep "vocabulary" as a top-level category**: rejected. Vocabulary is a derivative of reading, not a subject. Promoting it to category created the false symmetry that produced the editing tax in the first place.
- **Pre-curated materials only for some categories, free choice for others**: rejected. Mixed model defeats the procrastination defense for the free-choice categories. v1 is curated across the board.
- **Sixth category for prose-modeling separate from English-lit**: rejected. Prose-modeling *is* the English-language category in v1. No separate "English literature" category; the existing literary-narrative category (史记) handles narrative regardless of language.

## Consequences

**Positive:**
- The convictions are now internally consistent. Conviction #6 names what was implicit in 5; the revisit methods reflect what each category actually serves.
- Direction provides a steering anchor that the research strongly endorses for sustained practice.
- One-tap vocabulary capture removes the largest known procrastination vector in the design.
- Curated v1 materials eliminate the "what should I read today?" problem at the source. The user picks the materials once (encoded in the app); the LLM proposes the next encounter within those materials.
- CS:APP-as-re-read maximizes the value of revisit framing — the user already has a "first encounter" with the book; whetstone gets to be the second.
- Mirror response is the bridge between active recall (well-supported) and long-arc growth (the actual goal) that whetstone has been missing.
- Evidence calibration is now visible in STABLE.md, so future agents and the user can distinguish what to defend on evidence vs what to defend on principle.

**Negative / accepted risk:**
- Three different revisit methods (grade-based, mirror, generative) instead of one increases implementation complexity. Estimated +1-2 days of design+build in DailyRoutineService.
- LLM-generated vocabulary cards introduce a small accuracy risk. Mitigated by user-confirms flow; user will catch egregious errors.
- The 90-day cap on diminishing revisits remains arbitrary. We accept this and will revisit (no pun) after 90 days of real use.
- Curated-only materials in v1 means users with subjects outside the chosen five cannot use whetstone for those subjects until v2. Accepted because v1 is for the user, and the user's subjects fit.
- Weekly Echo review has thin research backing. We ship it because it operationalizes Conviction #6 cleanly; we will cut it if real use shows users skip it.

## Revisit triggers

- After 4 weeks of daily use: is the Echo weekly review producing real engagement, or being skipped? Cut or keep.
- After 90 days of literary narrative use: is the "then done" cap right? Items completing at 90d should still feel alive to the user — if not, the schedule extends.
- After 4 weeks: are the LLM-generated vocabulary cards being edited frequently? High edit rate means the generation prompt needs tuning; low edit rate means the design is working.
- Whenever a new type of material wants to enter whetstone: does it fit an existing category? If not, this triggers a v2-style category-authoring discussion.
- If the user finds themselves wanting to "test" themselves on diary or narrative: that's a signal Conviction #6 is being challenged. The conversation that follows should be about why, not about adding a quiz mode.
