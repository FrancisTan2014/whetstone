# DRAFT.md

What's in motion. Open questions. What comes next. Things that haven't earned a place in [`STABLE.md`](./STABLE.md) yet.

When something here gets locked, it moves to STABLE.md (often via an ADR) and the section is removed from this file.

**Last updated:** 2026-06-08

---

## Phase

**Design.** No code exists yet. v1 implementation has not started.

---

## Open: data model

The schema serving the locked methodology. Lives here until designed; will move to STABLE.md when locked.

### Requirements (must satisfy)

- Each note round-trips to a single `.md` file with YAML frontmatter (export-from-day-one rule).
- Frontmatter records the **category** (foreign key to category definition) and the **original answer** the user wrote at first encounter — this is the rubric for LLM grading per Conviction #5.
- Frontmatter holds per-category **algorithm state** (FSRS parameters, diminishing-revisits step, linked-surfacing graph edges).
- Body is plain markdown — no app-specific syntax.
- Stable string `id` is the filename.
- The `INoteStore` interface is the only contract for note persistence.
- A separate **spend log** table records LLM grading costs.
- `schema_version: 1` in frontmatter from day one.
- Schema must carry **pause state** (per category + per app).

### Open questions

- **Note ID scheme** — topic-prefix-date-slug? UUID? sequential? Trade-off: human-readability vs slug-rot.
- **Category representation** — separate table with FK? string column with code-side registry? Trade-off: flexibility vs type-safety.
- **Original-answer storage** — inline in body, separate frontmatter field, or separate table? Trade-off: export-readability vs queryability.
- **Per-category algorithm state shape** — one column per algorithm? JSON blob? polymorphic table? Trade-off: schema simplicity vs algorithm independence.
- **Spend log granularity** — one row per grading request, daily roll-up, both?
- **Pause state schema** — fields on Category/App table? Separate Pause table for history?

### Outputs when locked

- ADR documenting the schema decisions.
- "Data model" section in STABLE.md.
- This section deleted from DRAFT.md.

---

## Open: routine algorithm

The interleaving logic that produces a daily routine. Lives here until designed; will move to STABLE.md when locked.

### Function shape (sketch)

```csharp
DailyRoutine GenerateRoutine(
    DateOnly today,
    IReadOnlyList<Note> allNotes,
    IReadOnlyList<Category> categories,
    PauseState pauseState,
    RoutineConfig config // cap, category weights, ritual list
);
```

Returns:
- **Recall items** (≤ cap, interleaved across non-paused categories with eligible items via round-robin)
- **Deferred overflow** (items whose due date was today but didn't make the cap — next-surface pushed +1 day)
- **New-encounter slots** per active non-paused category (sized by category weight × available time)
- **Ritual slot** for daily reading — outside any recall queue (suppressed only if app-level pause AND user opted to pause ritual)

### Open questions

- **Round-robin ordering** — alphabetical by category? Weighted by user's per-category weight? Random per day to avoid the same category always being "first"?
- **Empty-day handling** — first weeks, before any category has due items: just show new-encounter slots, or suggest first encounter explicitly?
- **New-encounter completion** — checkbox that creates an empty note, or required to create a populated note before being marked done?
- **Minimum cap** — at what cap does the loop feel too quiet? Should the cap *floor* itself (always show at least N items if available)?
- **Linked surfacing interaction with cap** — concept/mechanism items have no clock-due date; how do they compete for cap slots with date-due items from other categories?
- **Pause skipping** — when iterating categories, paused ones are skipped entirely; should the slot allocation re-balance to give active categories more time, or stay fixed?

### Outputs when locked

- ADR documenting the interleaving algorithm.
- "Routine algorithm" section in STABLE.md.
- This section deleted from DRAFT.md.

---

## Tasks

### Completed

- ✅ v1 scope locked
- ✅ Engineering principles
- ✅ Stack
- ✅ Learning methodology (convictions, categories, algorithms, grading)
- ✅ Pause mechanism + decision-boundary framework
- ✅ Agent-instruction files (AGENTS.md, CLAUDE.md)
- ✅ Docs restructure (12 docs → STABLE + DRAFT + decisions/)

### Next

**Design data model** (this DRAFT.md section). Produces a new ADR and a "Data model" section in STABLE.md.

### Blocked

- **Project skeleton + agent-control mechanics** (`.editorconfig`, `Directory.Build.props`, pre-commit hook, CI workflow). Blocked on data model and routine algorithm.
- **Routine algorithm.** Blocked on data model.
- **Implementation** (storage, schedulers, routine generator, UI, seeding). Blocked on skeleton.

---

## Notes for the next agent

- Read [`AGENTS.md`](./AGENTS.md) first, then [`STABLE.md`](./STABLE.md), then this file.
- All locked decisions are in STABLE.md. If you can't find a decision there, it isn't locked.
- The user prefers to be asked when scope or taste decisions arise. Do not assume.
- The user pushes commits manually. Do not push to remote.
- To see what's local-only vs pushed: `git fetch origin && git log origin/main..HEAD`.
- Update this file at the end of any session that changes design state or completes a task.
