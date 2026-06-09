# DRAFT.md

What's in motion. Open questions. What comes next. Things that haven't earned a place in [`STABLE.md`](./STABLE.md) yet.

When something here gets locked, it moves to STABLE.md (often via an ADR) and the section is removed from this file.

**Last updated:** 2026-06-09

---

## Phase

**Design.** No code exists yet. v1 implementation has not started.

The methodology, voice scope, and curated materials are now locked in STABLE.md (see ADRs 0005 and 0006). What remains in design is the concrete schema and the routine-generation algorithm — both serving the now-stable methodology.

---

## Open: content origin + configuration as server data + admin role

> **For PM and Architect**: this is the next major design work. The decisions in §"Confirmed by user" below are locked input — do not re-litigate. The work is drafting ADRs that implement them.

### Why this is here

We had not answered: *where does the content the user reads actually come from?* And: *where do tunable things like prompt templates live as the user-and-the-app iterate?* Once posed, both questions point at the same answer — content and configuration are runtime data, not source-code constants — which is a meaningful expansion of what's already locked.

ADR 0008 (system architecture) already added a server with Postgres. Content and configuration naturally live in that database; the sync protocol naturally extends to fetch them. The architectural cost is small; the iteration-loop unlock is large (especially for prompt tuning, which will be ongoing).

### Confirmed by user (locked input — do not re-litigate)

1. **Content and configuration live on the server as data**, edited via an admin surface, fetched by clients on sync and cached locally. Specifically:
   - **Curated materials**: works, chapters, sections, encounter units. Hierarchical, per-subject.
   - **Prompt templates**: one per LLM-touching moment. Versioned so the human can roll back a bad tune.
   - **Category definitions**: templates, default weights, revisit-method bindings, slot-sizing defaults.
   - **Default settings**: daily budget, cap size, ritual list, FSRS initial parameters.

2. **Per-category material delivery** (hybrid by category):
   - **史记 (literary narrative)**: text held by the server as the admin's curated data, fetched and cached on client. User reads inside whetstone.
   - **Recitation (滕王阁序, 洛神赋, 笠翁对韵)**: text held by the server as the admin's curated data, fetched and cached on client. Required for recitation.
   - **Orwell essays (prose-modeling)**: text held by the server as the admin's curated data, fetched and cached on client. Cite the public-domain source in each entry's metadata.
   - **CS:APP (concept/mechanism)**: **reference only**. Server holds the chapter/section list and acceptance criteria; whetstone never holds the book's text. User reads externally; whetstone holds engagement notes and the revisit schedule.
   - **Reflection (diary)**: user-authored, no material.

3. **Admin role is human-only.** Agents do not edit materials, prompts, or category definitions. The human admin (= the user) is the only one who curates content and tunes prompts. This protects the convictions at the content layer specifically.

4. **Admin UI lives inside the whetstone client**, gated by an admin scope on the bearer token. Same MAUI Blazor codebase, an `Admin/` folder of pages visible only to a session whose bearer token carries the admin scope. No separate admin webapp.

5. **First-launch onboarding flow**: subject opt-in (with material-access checkboxes for the externally-read works) → Direction per opted-in subject → first encounter. The Direction-first sequencing means the user's first artifact in whetstone is their own declaration, not the app's recommendation. Honors Conviction #5 from the first moment.

### Open for ADR-writing (Architect's judgment)

These are the questions the ADRs need to answer:

- **Postgres schema** for `materials`, `prompt_templates`, `categories`, `default_settings` tables. Relationships, versioning columns, soft-delete vs hard-delete.
- **Sync protocol extension**: new endpoints (`GET /v1/sync/content`, `GET /v1/sync/prompts`, etc.) or a single `GET /v1/sync/everything?since=…` that returns notes + content + prompts in one envelope. Trade-offs: latency, payload size, polling cadence per content type.
- **Client cache strategy**: how often does the client re-fetch content? Push-on-change (server notifies) vs pull-on-launch + interval. Initial lean: pull-on-launch is enough for v1.
- **Prompt template structure**: pure string with `{placeholders}`? More structured (system + user blocks, with named slots)? Versioning model — every save is a new version, with `active_version` pointer per template?
- **Admin authentication**: how the bearer token gains admin scope. Initial lean: the server's first-boot token is the admin token; user can issue scoped tokens for regular client use later.
- **Admin UI surfaces in v1**: minimum is "edit materials, edit prompt templates, see versions, roll back." Anything else (preview, A/B test, diff between versions) is v2.
- **First-launch UX**: what does the user see if they install a fresh client before any subjects are opted in? What does the Today screen look like during onboarding?
- **Content updates after first install**: new 史记 chapter added by admin — does it appear in the user's queue automatically (LLM proposes it next), or does the user opt in per work?
- **Bootstrap problem**: how does the very first server install have any content at all? Initial lean: server ships with an empty content table; user (as admin) populates via the admin UI. No seed data shipped in source.

### Suggested ADR split

Architect's call to confirm, but the natural split:

- **ADR 0011 — Content and configuration as server-resident data.** Postgres schema, sync protocol extension, client cache, prompt template structure, content lifecycle. Includes amendment notes for ADR 0008 (Postgres now also holds these tables) and STABLE.md edits (Methodology → Categories section gets "material source: server-curated, cached on client"; new Methodology subsection "Prompt templates"; Stack section grows admin surface row; Scope (v1) adds the admin UI + content sync).
- **ADR 0012 — Admin role, admin UI, first-launch onboarding.** Admin scope on bearer token, admin UI surfaces in v1, first-launch flow (subject opt-in → Direction → first encounter), bootstrap problem. STABLE.md edits adding admin role to "What whetstone is" (single user with admin and user roles, same human).

Both touch STABLE.md → same-commit rule applies → STABLE.md updates land in the same commit as each ADR.

### Affects existing artifacts

When Architect picks this up, the following will need cross-reference updates:

- **STABLE.md** — Categories (material source), Methodology (prompt templates), Stack (admin UI surface; Postgres tables), Scope v1 (admin UI, content sync, first-launch flow), Cross-references.
- **ADR 0006** — superseded for the "audio never leaves device" claim (already done by ADR 0010); no further change needed here.
- **ADR 0008** — minor amendment noting Postgres holds content/prompts/categories in addition to notes; sync protocol extends.
- **AGENTS.md** — new hard stop for prompt/material/category editing (already added in this commit; Architect just references it).
- **COWORK.md** — admin role row in the team table (already added in this commit; Architect references it).
- **REVIEW_SPEC.md** — new reject pattern: "code that hard-codes a curated material, prompt template, or category definition that should be server-data" → reject; "agent-authored edit to materials/prompts/categories" → reject.
- **WIREFRAMES.md** — UX needs first-launch onboarding screens and admin UI wireframes after the ADRs land. PM should create a UX issue.

### Outputs when locked

- ADR 0011, ADR 0012 (single commit each, paired with STABLE.md updates per same-commit rule).
- STABLE.md gains the sections noted above.
- This section deleted from DRAFT.md.
- PM creates follow-up issues for: UX wireframes (onboarding + admin); Architect amendment to ADR 0008 (or notation that this ADR covers it); Developer scaffold work (once skeleton is requested).

---

## Open: data model

The schema serving the locked methodology. Lives here until designed; will move to STABLE.md when locked.

### Requirements (must satisfy)

- Each note round-trips to a single `.md` file with YAML frontmatter (export-from-day-one rule).
- Frontmatter records the **category**, the **subject's Direction** by reference, and the **original answer/entry** — the rubric for LLM grading and the prior-self for mirror response.
- Audio files referenced by filename, stored alongside the `.md` files, included in export bundle.
- Frontmatter holds per-category **algorithm state** (FSRS parameters for graded categories; diminishing-schedule step for narrative; linked-surfacing graph edges for concept; schedule offset for prose-modeling).
- Body is plain markdown — no app-specific syntax.
- Stable string `id` is the filename.
- The `INoteStore` interface is the only contract for note persistence.
- Separate **spend log** table records LLM grading + proposal costs.
- Schema must carry **pause state** (per category + per app).
- Schema must carry **Direction per subject** (one paragraph, editable).
- `schema_version: 1` in frontmatter from day one.
- **Voice-specific**: audio filename, duration, transcription confidence; transcripts stored alongside.
- **Vocabulary cards**: how does a card produced from any reading material reference its source? (subject? note id? quoted span?)

### Open questions

- **Note ID scheme** — topic-prefix-date-slug? UUID? sequential? Trade-off: human-readability vs slug-rot.
- **Subject vs Category vs Material relationship** — STABLE.md mentions all three. What's the data model? My current sketch: a Subject (e.g., "CS:APP re-read", "史记") owns a Direction; each Subject is bound to one Category; the Material is a structured list of encounter units (chapters, essays, passages) the LLM proposes from. Confirmable.
- **Original-answer storage** — inline in body, separate frontmatter field, or separate table?
- **Per-category algorithm state shape** — JSON blob? polymorphic table?
- **Spend log granularity** — one row per request, daily roll-up, both?
- **Pause state schema** — fields on Category/Subject/App table? Separate Pause table for history?
- **Vocabulary card structure** — how is the source citation stored? How does revisit fetch the original sentence for context?
- **Audio storage layout** — flat `audio/` folder with UUID filenames, or organized by date/subject?

### Outputs when locked

- ADR documenting the schema decisions.
- "Data model" section in STABLE.md.
- This section deleted from DRAFT.md.

---

## Open: routine algorithm

The logic that produces a daily routine, including the weekly Echo. Lives here until designed; will move to STABLE.md when locked.

### Function shape (sketch)

```csharp
DailyRoutine GenerateRoutine(
    DateOnly today,
    IReadOnlyList<Note> allNotes,
    IReadOnlyList<Subject> subjects,
    IReadOnlyList<Category> categories,
    PauseState pauseState,
    RoutineConfig config // cap, category weights, ritual list, Echo cadence
);
```

Returns:
- **Mode**: standard or Echo.
- **Revisit items** (≤ cap, interleaved across non-paused categories with eligible items).
- **Deferred overflow** (items whose due date was today but didn't make the cap).
- **New-encounter slots** per active non-paused subject (sized by category weight × available time), each with an LLM-generated proposal.
- **Ritual slot** for daily reading.
- **Echo pairs** (only if Echo day): 3-5 past/recent pairings from across subjects.

### Open questions

- **Echo cadence**: every 7th day from app install, every Sunday, or user-pickable?
- **Round-robin ordering** for revisits — alphabetical? Weighted? Random per day?
- **Empty-day handling** — first weeks, before any category has due items.
- **New-encounter completion** — checkbox that creates an empty note, or required to create a populated note before marked done?
- **Minimum cap floor** — at what cap does the loop feel too quiet?
- **Linked surfacing interaction with cap** — concept items have no clock-due date; how do they compete?
- **Pause skipping** — re-balance slot allocation, or stay fixed?
- **Proposal-and-Direction interaction** — how is the Direction text fed to the LLM proposal prompt? Always? Only on the day's first proposal?
- **Mirror response generation prompt** — concrete prompt structure for the LLM. Probably a separate prompt-engineering doc when implementation starts.

### Outputs when locked

- ADR documenting the algorithm.
- "Routine algorithm" section in STABLE.md.
- This section deleted from DRAFT.md.

---

## Tasks

### Completed

- ✅ v1 scope locked (then amended by ADRs 0003, 0004, 0005, 0006)
- ✅ Engineering principles
- ✅ Stack
- ✅ Learning methodology (convictions, categories, revisit methods, grading)
- ✅ Pause mechanism + decision-boundary framework
- ✅ Agent-instruction files (AGENTS.md, CLAUDE.md)
- ✅ Docs restructure (12 docs → STABLE + DRAFT + decisions/)
- ✅ Cognitive learning science research (RESEARCH.md)
- ✅ Major revision: revisit terminology, Direction, mirror response, vocabulary as layer, curated materials, voice as first-class (ADRs 0005, 0006)
- ✅ Multi-agent team architecture research (AGENT_TEAM_RESEARCH.md)
- ✅ Five-role agent team deployed Phase 1 (architect/pm/developer/tester/ux-designer in .claude/agents/, COWORK.md operating manual, hooks enforcing hard stops, ADR 0007)
- ✅ MAUI Blazor stack-specific code review research (REVIEW_NOTES.md) + REVIEW_SPEC.md + Architect's expanded scope (ADR 0008)

### Next

The team is now active. Decide which role to start with for what:

- **PM** — break the data-model and routine-algorithm design tasks into GitHub issues. Maintain DRAFT.md as items resolve.
- **Architect** — review any conviction-touching scope as PM creates issues. Begin design audits.
- **Tester** — draft TEST_PLAN.md (v1 test strategy) from STABLE.md.
- **UX designer** — draft WIREFRAMES.md (v1 screen inventory and flows) from STABLE.md.
- **Developer** — idle until project skeleton is requested by human (the skeleton task is human-gated per AGENTS.md).

### Blocked

- **Project skeleton + agent-control mechanics** (`.editorconfig`, `Directory.Build.props`, pre-commit hook, CI workflow). Blocked on data model and routine algorithm.
- **Routine algorithm.** Blocked on data model.
- **Implementation** (storage, schedulers, routine generator, voice pipeline, UI, seeding). Blocked on skeleton.

---

## Notes for the next agent

- Read [`AGENTS.md`](./AGENTS.md) first, then [`STABLE.md`](./STABLE.md), then this file.
- For research-backed reasoning about design choices, consult [`RESEARCH.md`](./RESEARCH.md).
- All locked decisions are in STABLE.md. If you can't find a decision there, it isn't locked.
- The user prefers to be asked when scope or taste decisions arise. Do not assume.
- The user pushes commits manually. Do not push to remote.
- To see what's local-only vs pushed: `git fetch origin && git log origin/main..HEAD`.
- Update this file at the end of any session that changes design state or completes a task.
