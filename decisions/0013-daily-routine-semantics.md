# ADR 0013 — Daily-routine semantics: fixed at 00:00, anchored on the user's primary timezone, no carry-over framing; per-category default input mode

**Date:** 2026-06-09
**Status:** Accepted
**Amends:** [ADR 0011](./0011-content-as-server-data.md) — `categories` table gains a `default_input_mode` column; `default_settings` gains a `primary_timezone` key. [ADR 0012](./0012-admin-role.md) — first-launch onboarding gains a "confirm primary timezone" step between subject opt-in and Direction.

## Context

The methodology in [STABLE.md → Daily loop](../STABLE.md#daily-loop) names what a routine contains (ritual + revisit + encounter + connect) and the cap mechanism for revisits, but it does not lock the *temporal semantics* of a day: when is "today" computed, against what clock, and what happens to items not done by the end of it. The UX session's design-principles draft in [WIREFRAMES.md → Today screen behavior](../WIREFRAMES.md#today-screen-behavior) made several behavioral commitments that the rest of the design depends on; this ADR moves the ones that touch convictions and the schema from WIREFRAMES into STABLE so future agents reading STABLE alone reach the same conclusions.

Four pieces are locked here as one bundle because they all answer "what *is* a day in whetstone" and "what does the user see on the Today screen because of it":

1. **When is "today" computed?** Per the user's *primary timezone*, at 00:00, once per calendar day. Not per-device-local-time (which would diverge across timezones), not live (which would surface items mid-day that the user did not see at breakfast).
2. **What happens to items not done by 23:59?** They are not "overdue." Tomorrow's routine generator reconsiders them per their normal scheduling rules.
3. **What is the cross-device contract?** All clients agree on what "today" is, by honoring the same primary-timezone value.
4. **What input mode does each category default to?** Voice or text, by the natural shape of the speech act per category. Stored on the `categories` row so admin can edit; defaults seeded from the UX table.

[ADR 0011](./0011-content-as-server-data.md) put `categories` and `default_settings` into server-resident data. The two schema additions here ride that mechanism — they are not new tables, not new seams.

The UX session's design-principles draft is the source of (1)–(3); the user has reviewed that draft. The UX flag — "downstream flags 4, 5, and 1 (carry-over)" — explicitly asked Architect to land these somewhere. This ADR is that landing.

## Decision

### 1. The day is fixed at 00:00 in the user's primary timezone

**Rule.** `RoutineGenerator.Generate(today, ...)` is invoked once per local calendar day per client, with `today` computed as `DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(primaryTimezoneOffset).DateTime)`. The list produced is what the user sees until the next 00:00 in the primary timezone.

- **No live re-generation during the day.** Once today's list exists, items are not added, removed, or reordered until tomorrow. Done items are *muted in place* per [WIREFRAMES → Today screen behavior](../WIREFRAMES.md#today-screen-behavior); unfinished items remain visible at their original position.
- **No mid-day arrivals.** If sync brings in a new note from another device, or the admin adds new material, those changes update the *underlying data* but do not modify the day's already-rendered routine. Tomorrow's generator will consider them.
- **Implementation note (advisory, not normative):** the trigger for "compute today's list" is the first sync after local-time-midnight on the primary timezone. If the client is asleep at midnight, the first foreground activity after midnight computes the list. The list is cached locally (a single `todays_routine` row keyed by `(client_id, date)` in the client SQLite); subsequent loads in the same day read the cache.

### 2. The user's primary timezone is a `default_settings` key

A new key joins the `default_settings` table from [ADR 0011 §2](./0011-content-as-server-data.md#2-postgres-schema-server-side):

| key | value type | example |
|---|---|---|
| `primary_timezone` | text (IANA timezone name) | `"Asia/Shanghai"` |

**Why a settings key, not per-device:** the personal-knowledge-library promise from [ADR 0008 §2](./0008-system-architecture.md#2-quality-attributes-what-we-are-optimizing-for-what-we-are-trading-away) is that opening the laptop sees the same notes as the phone. The same has to be true of "today's routine" — if the laptop and the phone disagree on what "today" is, the user has two competing routines. A single settings key avoids that. The user-as-admin sets this once via the admin UI; all clients honor it.

**Trade-off:** when the user travels across timezones, the day still flips at midnight-in-Shanghai (or wherever the primary is set), not at midnight-where-the-user-is. For a personal app where the user is mostly in one place, this is correct. For a true digital-nomad case, the admin can edit `primary_timezone` from the road; the next sync rolls all clients onto the new day-anchor.

**Default:** ships unset. The first-launch onboarding flow ([ADR 0012 §3](./0012-admin-role.md#3-first-launch-onboarding)) is the natural place to capture it — added below as a sub-decision.

#### 2a. First-launch onboarding captures `primary_timezone`

[ADR 0012 §3](./0012-admin-role.md#3-first-launch-onboarding) defined the onboarding flow as subject opt-in → Direction → first encounter. This ADR inserts one step before Direction:

```
Paste bearer token → First sync → Subject opt-in →
  ┌───────────────────────────────────┐
  │ NEW: confirm primary timezone     │
  │ (defaults to device's current     │
  │  IANA timezone; user can change)  │
  └───────────────────────────────────┘
→ Direction per opted-in subject → Today screen
```

The device's current IANA timezone is offered as the default; the user can change it before continuing. This is the only configuration step in onboarding outside of subject opt-in and Direction; it is gated to first install only. Subsequent installs read `primary_timezone` from the sync payload and skip the step.

### 3. Items not done today are not "overdue"

**Rule.** When tomorrow's routine generator runs, it considers all items per their normal scheduling rules — exactly as if today had never happened. Items shown today but not done:

- For graded categories (recitation, vocabulary, concept) with FSRS: the FSRS state is unchanged; the next-due date is unchanged. The item may surface again tomorrow because it was due today *and is still due*. It may not surface because the cap is full of more-overdue items or other categories' due items in the round-robin (per the existing cap mechanism, [STABLE → Revisit queue selection](../STABLE.md#revisit-queue-selection-the-cap-mechanism)).
- For mirror categories (narrative, reflection, prose-modeling) on a diminishing schedule: the next-due date is unchanged. Same surfacing rules tomorrow.
- For linked-surfacing (concept items that surface on neighbor encounters): unchanged.
- For new-encounter slots: a slot the user did not engage with today is not "carried over." Tomorrow generates a fresh proposal for its category's slot.

**What is explicitly *not* in this rule:**

- ❌ "Overdue" banner, counter, or list. ([Conviction #3](../STABLE.md#the-six-convictions); [WIREFRAMES → Absence of metrics](../WIREFRAMES.md#absence-of-metrics).)
- ❌ Bumping yesterday-undone items to the top of today.
- ❌ Marking the user's day as "incomplete," with or without UI.
- ❌ Lapse recording in FSRS for an item that was surfaced but not attempted. FSRS lapses are recorded only on a Forgot grade per the existing methodology; a non-attempt is not a Forgot.
- ❌ Bonus priority weight for items that have been shown N days in a row without being done.

**Relationship to the existing cap-overflow rule** ([STABLE → Revisit queue selection](../STABLE.md#revisit-queue-selection-the-cap-mechanism), step 4: "Items left over: next-surface date pushed forward by 1 day"): that rule applies when the day's *generation* exceeds the cap — the algorithm picks 15, the rest get their next-surface dates bumped to keep the queue from compounding. This ADR's rule applies when the day's *engagement* falls short — the user saw the items but did not act on them. The two rules cohabit cleanly: cap-overflow bumps schedule-state (a deliberate algorithmic choice); end-of-day undone items leave schedule-state untouched (a deliberate refusal to penalize).

### 4. `categories.default_input_mode` (voice | text)

The `categories` table from [ADR 0011 §2](./0011-content-as-server-data.md#2-postgres-schema-server-side) gains one column:

```
categories
├── … (existing columns)
└── default_input_mode  enum: voice | text
```

**v1 default values** (seeded by admin during the bootstrap content-population step from [ADR 0011 §7](./0011-content-as-server-data.md#7-content-lifecycle), drawing on [WIREFRAMES → Voice and input](../WIREFRAMES.md#voice-and-input)):

| Category | `default_input_mode` |
|---|---|
| Literary narrative (史记) | `text` |
| Recitation | `voice` |
| Prose-modeling (Orwell) | `text` |
| Concept/mechanism (CS:APP) | `text` |
| Reflection (diary) | `voice` |

**Vocabulary is not a category** ([STABLE → Vocabulary as a layer, not a category](../STABLE.md#vocabulary-as-a-layer-not-a-category)) and therefore does not have a `categories` row. Vocabulary capture and vocabulary recall flows specify their own input-mode defaults inside WIREFRAMES (capture is tap-then-confirm; recall is text per the UX table) — there is no schema decision to make for vocabulary in this ADR.

**The non-default mode is always one tap away** per [WIREFRAMES → Voice and input](../WIREFRAMES.md#voice-and-input). The schema's `default_input_mode` only sets which mode the page opens in; it does not gate the other mode.

**No preference-learning in v1.** The default does not adapt to the user's previous-session choice; the category's natural shape is fixed. (UX-locked; restated here so a future agent does not propose "remember what the user picked last time" as a quality-of-life addition without first re-opening this ADR.)

### 5. Anti-rule check

- **No new seam.** Two schema additions on existing tables (`categories` gains one column; `default_settings` gains one key). The four-seam rule holds.
- **No new dependency.** Timezone conversion uses `TimeZoneInfo` from `System` (BCL); IANA timezone identifiers are supported on all .NET 8 platforms (`TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai")`). No new package.
- **No new component.** `RoutineGenerator` keeps the same signature (`DateOnly today` is already its first parameter per [DRAFT.md → Open: routine algorithm](../DRAFT.md#open-routine-algorithm)); the caller is responsible for computing `today` correctly.
- **No `*Manager` / `*Helper`.** Timezone conversion is two lines at the caller; no `TimezoneService`, no `DayAnchorHelper`.
- **No `IClock`.** `DateOnly today` flows in as a parameter, as locked by [ADR 0008 §9](./0008-system-architecture.md#9-project-layout--flat-folders-by-feature) ("`RoutineGenerator` takes `today` as a parameter; tests pass a fake date"). The timezone-aware computation lives in the calling code (the page or onboarding handler).

## Alternatives considered

- **Per-device local-time "today" (no primary-timezone setting).** Rejected. Two devices in different timezones see different routines for the hours of overlap when one device's date has flipped and the other hasn't. The personal-knowledge-library promise asks for the opposite shape.
- **Server-computed "today" (server stamps the routine with a date, clients render).** Rejected. Server outages would break routine display; conviction #1 (daily encounter) is structural and depends on clients computing everything locally from cached state. Local computation with a shared timezone-anchor preserves both properties.
- **Live-updating Today (items appear during the day when sync brings them in).** Rejected. Surfaces items mid-day that the user did not see at breakfast — the routine becomes a moving target, the calm of "this is today's work" collapses into "what's been added since I last looked." Wireframes explicitly refuse this. Tomorrow's generator will pick up new arrivals.
- **Carry-over with explicit "yesterday" section on Today.** Rejected. Visually frames undone items as backlog; primes the user to feel behind. Conviction #3 (forgetting is data, not failure) and the [pause-mechanism's "no shame" framing](../STABLE.md#pause-mechanism) both argue against. If a user genuinely cares to see what they didn't do yesterday, the archive (a UX-proposed v1 screen — see Open follow-ups below) is the place for that, not Today.
- **Forgot-grade for surfaced-but-not-attempted items.** Rejected. A Forgot grade is the user reporting they could not recall. A non-attempt is not the same signal. Conflating them would silently lapse items the user simply ran out of time for — the opposite of the conviction.
- **Per-device `primary_timezone` overrides.** Considered for the digital-nomad case. Rejected for v1. Two `primary_timezone` values means two routines per user per day; recreates the cross-device disagreement. If real users (plural) ever materialize and travel, revisit. For a single user mostly in one place, one timezone is correct.
- **No timezone configuration; UTC.** Rejected. The user's "today" is not UTC; midnight UTC is 8am in Shanghai or 7pm in New York. The day-anchor must align to the user's lived day.
- **`default_input_mode` per-user-per-category (a user can change defaults).** Rejected for v1. The category's natural shape is fixed per [WIREFRAMES → Voice and input](../WIREFRAMES.md#voice-and-input); per-user customization adds settings surface for a benefit the v1 user has not asked for. The admin can change the category-level default if the v1 user finds the shape wrong; that is the available lever.
- **Adapt input-mode default based on the user's previous session.** Rejected. Preference-learning surface for a setting the user can flip with one tap. Adds opacity (the user can no longer predict which mode the page opens in) for marginal benefit. WIREFRAMES is explicit.
- **A separate `routine_days` table on the server storing each day's generated list.** Rejected. Routines are client-generated from synced state; persisting them server-side would force a sync conflict story for the routine itself, and would not give the user anything that "open today, see today's list" doesn't already give them. The local cache (per §1) is sufficient.

## Consequences

**Positive:**

- **Conviction #1 (daily encounter) is preserved.** The day's list is fixed and local-cached; the user sees today's routine even when offline, when the server is rebooting, when sync is hours behind.
- **Conviction #3 (growth, not retention) is structurally protected.** No "overdue" framing, no shame banners, no pile-up of past undones. The cost of refusing these is named explicitly so future agents do not re-propose them.
- **Cross-device coherence.** All devices that sync see the same "today" because they honor the same `primary_timezone`. The personal-knowledge-library promise holds for the routine, not only for the notes.
- **Wireframes have a STABLE anchor.** The "fixed at 00:00, items muted in place, no overdue, no live update" behaviors that the rest of the UI depends on are now locked in STABLE — UX can write screens against a stable referent.
- **Schema growth is minimal.** One column on `categories`, one key in `default_settings`. EF Core migration is trivial.
- **First-launch friction stays small.** One extra confirmation step, defaulted to the device's current timezone — the user usually just clicks continue.

**Negative / accepted risk:**

- **Travel friction.** A user in a different timezone sees their day flip at "home midnight," not local midnight. For v1 (one user, mostly one place) this is fine; the admin can edit `primary_timezone` mid-trip if it bites. The right time to revisit this is when a user reports it actually bothering them.
- **Midnight-edge cases.** A user up at 23:59 may finish writing into a note that, three minutes later, is part of "yesterday's routine" (now muted) — the note itself was saved on yesterday's date. This is honest behavior (saves are time-stamped at save-time), but a user who finishes at 00:02 may wonder why their work appears under "yesterday." Acceptable; the alternative (extending today's routine by N minutes past midnight) introduces a fuzzy boundary that creates worse confusion.
- **The "items not done today" rule means a busy week may quietly leave material un-engaged for weeks** without any user-visible signal that material is sitting un-engaged. This is intentional — Conviction #3 explicitly refuses surfacing this — but a v1.5 revisit may be warranted if the user wishes (themselves, not by an agent's judgment) to see what has been sitting longest. The archive screen (UX-proposed) is the natural future home for any such view, not Today.
- **`primary_timezone` is admin-edited.** A non-admin user-scoped device cannot change it; only the admin (= the user) can. Not a concern for single-user v1; named for completeness.
- **`default_input_mode` lives at the category level, not per-note.** A user who wants to type a recitation entry must tap to switch mode every time. Acceptable per "non-default mode is one tap away"; revisit if real use shows the switching is tax.

## Revisit triggers

- **A user travels enough that the home-timezone day-anchor feels wrong.** Revisit per-device override or a "trip mode."
- **A user requests "show me what's been sitting longest"** (themselves; not surfaced by Architect or Developer). Re-open Conviction #3's treatment of un-engaged material; consider an archive view with "least-recently-touched" sort, never a Today-screen surface.
- **WIREFRAMES revises the muted-list / no-live-update treatment** based on first-week use. The rules in §1 of this ADR follow; STABLE update + new ADR if substantive.
- **A second user ever uses whetstone.** `primary_timezone` becomes per-user-not-per-system; multi-tenant onboarding rework.
- **A category's input-mode default proves wrong in real use.** Admin edits the `categories` row; no ADR needed for one-time correction. If the *rule* (category-level, not per-note) proves wrong, ADR.
- **The cap mechanism interacts unexpectedly with the no-carry-over rule** (e.g., the same item sits surfaced for 5 days in a row because no one ever does it and the cap keeps choosing it as "most overdue"). Investigate whether the round-robin step needs a stagnation guard. ADR if the rule changes.

## Open follow-ups (handed to PM)

These are not decisions this ADR locks; flagged here so they do not get lost.

- **Archive screen** ([WIREFRAMES → Absence of metrics](../WIREFRAMES.md#absence-of-metrics) flag 1) — UX proposes adding a browseable, no-metrics archive as a v1 screen. Architect endorses the design fit (Conviction #6 — "meeting your past self" — is well-served by an archive; the no-metrics constraint is honored); the *scope* decision (whether to add it to v1 or defer to v1.5) belongs to PM. Worth noting: if archive lands in v1, it is the natural home for any future "show me what's been sitting longest" view, sparing the Today screen from carrying that signal.
- **WIREFRAMES revision** — UX should remove the "DRAFT — pending user review" marker on the design-principles section once the user signals review is complete. UX-owned.
- **`Today` cache schema** — the `todays_routine` cache table mentioned in §1 (advisory) is implementation detail for the data-model ADR (still open in DRAFT.md). No decision here; future ADR.
