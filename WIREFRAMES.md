# WIREFRAMES.md

The v1 UI inventory and interaction patterns for whetstone. Owned by UX designer (per [COWORK.md](./COWORK.md)).

**Status:** stub. UX drafts this document during the design phase. Developer implements against it when UI work begins.

---

## What this document is

A specification of every user-facing screen and flow in v1. ASCII wireframes for layouts; Mermaid for flows; sentence-level interaction descriptions. The goal is that Developer can implement against the spec without guessing intent.

This document does NOT cover:

- Visual styling. Whetstone v1 uses MAUI Blazor defaults (per [STABLE.md anti-rules](./STABLE.md#anti-rules--explicitly-not-doing-in-v1): no themes / dark mode in v1).
- Prompt engineering for LLM grading or mirror response. The user-visible *result* of a prompt is in scope here; the prompt itself is Developer + Architect's concern.
- Backend behavior. UI specs reference [STABLE.md](./STABLE.md) behavior; they do not redefine it.

---

## How to fill this in

When UX begins drafting, the document should grow to include:

1. **Screen inventory** — every screen in v1: Today, Recall, New Encounter, View/Edit Note, Settings (with sub-screens for API key, daily budget, spend log, pause status, export). One section per screen with wireframe + flow notes.
2. **Interaction primitives** — how is mic invoked (button, keyboard shortcut)? How is one-tap vocabulary capture invoked while reading? What does the mirror response look like (modal, inline, side-by-side)? Choose, justify, document.
3. **Flow diagrams** — the daily-routine flow, the new-encounter flow, the recall-grading flow, the weekly Echo flow, the pause flow. Mermaid `flowchart` is fine.
4. **Empty states** — what does the Today screen look like on day 1 (no revisits due, no encounters started yet)? What does it look like during a loop pause?
5. **Conviction-fit notes** — for each screen, a short note on which convictions are most visible here and how the design honors them. Example: the Today screen must not show overdue counts, streaks, or anything that would make the user feel they're behind.

---

## Convictions UX must protect

For quick reference (full text in [STABLE.md → The six convictions](./STABLE.md#the-six-convictions)):

1. Daily encounter beats sporadic effort. *UI implication:* the routine always has something small and doable; no "you've fallen behind" framing.
2. Joy is fuel, not a luxury. *UI implication:* ritual slots feel different from work slots — softer affordance, no grading UI.
3. Growth, not retention, is the goal. *UI implication:* no streak counters, no badges, no progress percentages framed as completion. The spend log is functional, not vanity, and is the only metric UI in v1.
4. Templates structure engagement; they do not quiz. *UI implication:* the template prompts are scaffolds for the user's writing area, not multiple-choice questions or fill-in-the-blank fields.
5. Your past self is the rubric. *UI implication:* when showing LLM feedback (grade or mirror response), the user's original answer is always visible as the comparison point — not just the LLM's verdict.
6. Revisit is meeting your past self with your present mind. *UI implication:* the mirror response screen is intentionally different from the grade screen — softer, more reflective, no rating UI.

---

## (UX designer: begin here)

_Document body starts below. The above is preamble for any agent reading cold._
