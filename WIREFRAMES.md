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

## Design principles

> **DRAFT — pending user review (2026-06-09).** Synthesized from a 15-question conversation locking the aesthetic, postural, and structural commitments below. Not yet locked; the user has not yet read this draft and confirmed. Do not treat as authoritative until the "DRAFT" marker is removed.

The aesthetic, postural, and structural choices that shape every screen in v1. Locked through conversation with the user; future design decisions are evaluated against these. If a future change would require breaking one of these, an ADR is needed.

These principles are not a style guide. They are *prior commitments* — what whetstone has decided to be before any specific screen is drawn.

### Aesthetic envelope

**Warm-quiet, paper and ink.** The canvas is off-white (cream, not gray, not yellow — around `#FAF7F2`). The reading face is a serif (Iowan Old Style, Charter, IBM Plex Serif, or similar) — *not* a geometric sans. Sans is permitted only for tiny utility chrome (timestamps, settings labels). Edges are soft. There are no drop shadows, gradients, or glassmorphism. Color is nearly absent: black-ish ink on cream, with at most one muted accent (a faded ink-blue, a soft terracotta) for the rare moment something must be picked out. No category color-coding. No status colors that mean "good/bad."

The intended feel is *worn-in, not crafted*. A desk that has been used, not a desk being shown off. The discipline against preciousness: if we are tempted to add a "nice touch," we don't. The serif is a reading serif, not a display serif. Spacing is generous but not theatrical. Anywhere the design starts performing its own restraint, back up.

### Posture toward the user

**Teacher in the next room.** Whetstone has prepared the day's work with care and stepped away. The user senses they are not alone, but they are not being watched. The app addresses the user as *you*, quietly. It does not greet, celebrate, encourage, or apologize. It does not initiate; it does not notify; it does not interrupt. It does not perform care. The care lives in *what has been prepared* — the proposal rationale, the mirror response, the Echo pairings — not in language *about* having cared.

This metaphor places a load-bearing requirement on the LLM-generated content. The proposer's one-sentence rationales, the mirror responses, the Echo pairings — these must be specifically good. *Generic* LLM output ("Continue with Chapter 3," "Your thinking shows interesting development") collapses the metaphor and tips the app into "an automated system pretending to be personal," which is worse than honest automation. Prompt design is therefore design-load-bearing; specifications for these three voices appear in the wireframes for the screens that surface them.

### Voice of the writing

**One voice across the app, lightly warm, carried throughout.** Every visible string is written prose, by a person, with the natural variation in weight a careful writer would give the moment. Some sentences land warmly; some land plainly. The unity is in the hand, not in the temperature.

Properties of the system voice:
- Complete sentences. Not "Budget exhausted" but "Today's budget is used."
- The user is addressed as *you* when addressed at all.
- The sentence names what is true *and* what is available now, in one breath.
- No hedging, no apology, no encouragement.
- No exclamation marks, ever.
- No template language (`{0} items remaining`, "Field is required") — every visible string is hand-written.
- No tooltips or "?" help icons — if a sentence can't explain itself, rewrite the sentence.

The system voice is distinct from three LLM content voices that coexist in the app:
- **The proposer** — one-sentence rationale on encounter lines ("Next in Orwell, because you wanted to start with clarity").
- **The mirror** — paragraph commentary in the margin of mirror revisit screens.
- **The grader** — terse, no warmth: "Solid," "Partial," "Forgot," "Stronger."

These are three distinct registers. Same teacher; three different acts.

### The convictions made structural

**Grade and mirror revisits share one shell; texture and register differ.** Same overall layout, same navigation, same way to advance. The shift between them lives in the texture inside: grade screens are compact, upright, efficient (the high-volume path — vocabulary FSRS alone could be 20+ items a session); mirror screens are spacious, with the user's past writing given prominent real estate. Language differs ("Recall the passage" vs "You wrote this on March 4th. What's shifted?"). Buttons that imply judgment ("Submit") are absent on mirror screens. The structural distinction Conviction #6 requires lives in *how the screen reads*, not in *how it's built*.

**The mirror response sits beside the user's writing as margin commentary, never below or after.** On wide screens, two columns: the user's past entry and present writing in the main column (60–65% of content width); the LLM mirror response in a narrower italic margin column (30–35%), top-aligned with the *present* writing (the shift is what's being commented on). The convention is the page of a classical critical edition — text and marginalia. On narrow screens, the margin collapses to *below* the present writing, keeping the italic and smaller-size treatment intact. The mirror never appears as a centered card, a colored block, or a labeled "AI Response" section — those treatments would frame it as a verdict.

**Past writing is muted from present writing on the same page.** Same hue family, different value — present ink is deep, past ink is softer (a graphite tone, still readable, clearly *not as immediate*). Same font, same weight, same size. Dates are absolute ("March 4th" or "March 4, 2026"), not countdowns ("60 days ago" — that may appear alongside as context, but the absolute date anchors). No framing, no quotation marks, no "from your journal" labels. The eye learns the texture; the conviction (your past self is the rubric) becomes visible.

This muting treatment also marks "done today" on the Today screen — see *Today screen behavior* below. The principle is the same: *muted ink means this is no longer the active edge*. Whether the item is past in time or settled within today, the visual meaning unifies: this is no longer the work in front of you.

**Past writing is canonical. No edit, no delete in v1.** Once a note is saved, it is fixed. The Direction is the explicit exception (per STABLE — it is editable). Everything else — reflections, template-fills, mirror responses, revisit answers, vocabulary cards — is locked at the moment of save. Typos stay. The cringe of reading something poorly phrased a year ago is part of meeting your past self. Saving is therefore deliberate, not automatic — no autosave; a draft is in-progress until the user commits.

Deletion is not available in v1. If a year of real use shows the no-delete rule breaks the practice, it can be revisited via ADR. For v1, no delete. The user's escape hatch is the export — they can edit `.md` files outside whetstone if they truly need to.

### Absence of metrics

**No counts in the daily loop.** No streak. No progress bar. No "X of Y done." No headline count of today's items. No completion mark. The Today screen presents the day's work as a typographic list — not a dashboard, not a task tracker.

**An archive of past writing exists as a v1 screen.** Browsable, filterable by subject and category, reverse-chronological. Each entry shows title (or first line), date, category, source material. The archive is a *library*, not a *dashboard* — no entry counts, no word totals, no per-week numbers, no heatmap of activity. Search is deferred to v2 per STABLE; v1 archive is browse, not search. *(Adding the archive to the v1 inventory is a small scope addition; flagged to PM.)*

**Numbers exist for orientation, never for evaluation.** The orientation-allowed list:
- The spend log (STABLE-required, in Settings).
- Position in curated material — "Chapter 3 of 12" — so the user knows where they are in the arc.
- Word count while writing — quiet, in compose, gone on save.
- Dates and time-distances ("March 4th," "60 days ago" as context).

The evaluation-forbidden list:
- Anything on the Today screen that counts the day's work.
- Anything in the archive that measures volume.
- Anything that counts consecutive days.
- Anything that frames the user's *practice* as a number.

The test for any future number: does this help the user *orient* (where am I, how long is this), or *evaluate themselves* (how much have I done, how consistent have I been)? Orientation in. Evaluation out.

### Today screen behavior

The Today screen is the daily loop's home. Its behavior is settled enough to belong in the principles, because the rest of the design depends on it.

**The day's routine is fixed at 00:00.** The `RoutineGenerator` produces today's list once, at midnight, and that list is what the user has for the rest of the day. No items appear during the day; no items leave the list when done. The list at 8am and the list at 8pm have the same items in the same order — only the *textures* differ based on what's been done.

**Today is a quiet typographic list, not a dashboard.** Items appear as written-prose lines, not as structured rows with icons and counts. The list has no section headers ("REVISITS"), no category labels with counts, no progress chrome. Spacing and typography carry the hierarchy. The encounter line includes its one-sentence rationale from the proposer — written so it reads as a note from the teacher, not a system label.

**Items open into focused screens.** Tapping an item leaves the list behind and gives the item its own full screen. Closing the item returns to the list. The work never happens *on* the Today list — only the index does.

**Done items are quieted, not dismissed.** Finished items remain on the list in muted ink (same treatment as past writing). The user can tap any muted item to read what they wrote there. As the day progresses, the list visually records what has been done: morning the list is mostly present ink; evening it is mostly muted. The user can read today's writing by tapping muted items — no separate "today, gathered" view is needed.

**The end of the day is unmarked.** When the last item is done and the whole list goes muted, *nothing happens*. No transition. No banner. No "today's routine is done" text. The fully-muted list *is* the record. The user reads what they wrote by tapping items, then closes the app. At 00:00 the next day, tomorrow's list is generated; today's muted list is gone (accessible thereafter only through the archive, by date).

**Items not done today are not "carried over" as overdue.** When tomorrow's routine is generated at 00:00, the algorithm decides what to put on tomorrow's list. Unfinished items return to their normal scheduling — they may appear tomorrow, or later, or not soon — but they are never framed as *overdue* or *backlog*. *(This may want a corresponding line in STABLE; flagged to PM.)*

### Voice and input

**Input mode default varies per category, based on the natural shape of the speech act.**

| Category | Default | Why |
|---|---|---|
| Reflection (diary) | Voice | Speaking lowers the editor; the transcript captures actual thought. |
| Recitation | Voice | Memorizing is fundamentally a speaking act. |
| Narrative (history) | Text | Compositional, often longer-form. |
| Prose-modeling | Text | The craft *is* the writing. |
| Concept / mechanism | Text | Re-derivation is structured prose. |
| Vocabulary recall | Text | Short, fast — typing beats voice-then-confirm. |
| New encounter templates | Text | Multi-field, kept in writing rhythm. |

The non-default mode is always one tap away. The category's default does not change based on the user's previous-session choice (no preference-learning; the category's natural shape is fixed).

**Mic gesture is mapped by speech-length, not by category arbitrarily.**

- **Press-and-hold** for short speech: vocabulary capture, recitation, short recall. Speech bounded by the hand. On desktop without touch, the equivalent is *hold spacebar*.
- **Tap-to-start / tap-to-stop** for sustained speech: diary, mirror responses, narrative writing, prose reading-aloud. Speech bounded by intent.

The two gestures must be visually distinct so the user knows which is in play. No auto-stop on silence — the app does not interpret the user's pauses. No third gesture. Single screens do not mix gestures.

### Density and pacing

**The app is unhurried in register, fast in execution.** Most actions are instant — taps, saves, navigation, mark-done. The unhurried feeling is carried by typography, layout, and writing, not by added latency. There are no animations on routine actions.

**Three weighted moments get a small settle (≈300ms).** Accomplished through content arrival (a brief fade-in of the mirror text) rather than UI delay (a stalled screen transition). The three:
- The mirror response arriving in the margin.
- Opening the Echo review.
- The first open of the app each day.

*(A fourth — "the Today screen's shift to today's writing at end-of-day" — was considered and superseded. The Today screen does not shift; the muted list is the record. See Today screen behavior.)*

If during implementation more moments feel "they should have a beat too," that is drift — refuse it. Weighted moments are chosen and rare, or they cease to be weighted.

### What this design refuses

Stated explicitly so future agents have an unambiguous list. These are not "we haven't decided" — they are *refused*:

- No streaks, no badges, no "X days in a row," no per-week activity charts.
- No greetings ("Welcome back," "Good morning").
- No celebrations ("Great work!", "Day complete!", "✓ Done").
- No notifications, no reminders, no "haven't seen you in N days" messaging.
- No mascot, no personality features, no varying-for-variety system messages.
- No category color-coding.
- No light/dark theme toggle (v1 — per STABLE anti-rules).
- No emoji in system text. No exclamation marks.
- No tooltips or help icons.
- No autosave. No edit-after-save. No delete in v1.
- No configurable Today (no reordering, no show/hide, no compact view).
- No "today's writing, gathered" as a separate view.
- No live-updating routine (the day's list is fixed at 00:00).

### Downstream flags

These are decisions or implications that fell out of the principles and need to land elsewhere. *(After user review, these likely move to DRAFT.md as work-in-motion rather than living here as locked design.)*

1. **Archive is a new v1 screen.** Not present in the preamble's screen inventory. Scope addition — flagged to PM.
2. **LLM prompt quality is design-load-bearing.** The proposer, mirror, and Echo prompts must produce content worthy of the teacher metaphor. The wireframes for those screens will give register samples. Flagged to Architect.
3. **Category metadata needs a `defaultInputMode` field.** Per the voice/text default per category. Small STABLE update — flagged to PM.
4. **Carry-over policy for incomplete days.** Implied by Today-screen behavior: unfinished items are not overdue; they return to normal scheduling. May want a STABLE line. Flagged to PM.
5. **Two ink values, not two colors.** Present ink and muted ink are one substance at two ages, not two palette entries. To be honored in the eventual design system.
6. **Press-and-hold needs a desktop story (spacebar).** Will be specified in the mic interaction wireframe.
7. **The encounter proposer's output must fit a Today list line** — one sentence, not a paragraph. Prompt-design constraint with UI consequences. Flagged to Architect.

---

## (UX designer: begin here — screen-level wireframes)

_Screen-by-screen wireframes start below. Principles above are the authority for any layout decision; specific screens specify the rendering._
