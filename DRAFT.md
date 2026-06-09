# DRAFT.md

What's in motion. Open questions. What comes next. Things that haven't earned a place in [`STABLE.md`](./STABLE.md) yet.

When something here gets locked, it moves to STABLE.md (often via an ADR) and the section is removed from this file.

**Last updated:** 2026-06-09

---

## Phase

**Design.** No code exists yet. v1 implementation has not started.

The methodology, voice scope, and curated materials are now locked in STABLE.md (see ADRs 0005 and 0006). What remains in design is the concrete schema and the routine-generation algorithm — both serving the now-stable methodology.

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
