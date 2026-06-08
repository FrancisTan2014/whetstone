# Data model

> 🚧 **Placeholder, superseded in part** — original sketch assumed a single SRS algorithm per note. The methodology pivot (see [`06-methodology.md`](./06-methodology.md) and [ADR 0003](./decisions/0003-learning-methodology.md)) introduces categories, each with its own recall algorithm and template. The data model must be rewritten against the new methodology.

To be filled in during the resumed Task #2 (now: data model serving the locked methodology).

Design must satisfy:

- Each note round-trips to a single `.md` file with YAML frontmatter (export-from-day-one rule).
- Frontmatter records the **category** (foreign key to category definition) and the **original answer** the user wrote at first encounter — this is the rubric for LLM grading per Conviction #5.
- Frontmatter holds per-category **algorithm state** (FSRS parameters, diminishing-revisits step, linked-surfacing graph edges).
- Body is plain markdown — no app-specific syntax.
- Stable string `id` is the filename.
- The `INoteStore` interface is the only contract for note persistence.
- A separate **spend log** table records LLM grading costs (see [`06-methodology.md`](./06-methodology.md)).
- `schema_version: 1` in frontmatter from day one.

Open questions to resolve in resumed Task #2:
- ID scheme (timestamp? topic-prefix-slug? user-defined?)
- How are categories represented in storage? (Separate table? Just a string column with a registry of known categories?)
- How is original-answer-per-encounter stored — inline in body, separate frontmatter field, or separate table?
- How is per-category algorithm state shaped (one column per algorithm, JSON blob, or polymorphic table)?
- How does the spend log relate to grading requests (one row per request, daily roll-up, both)?
