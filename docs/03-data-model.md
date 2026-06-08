# Data model

> 🚧 **Placeholder** — to be filled in during Task #2 (Design data model).

Design must satisfy:

- Each note round-trips to a single `.md` file with YAML frontmatter (export-from-day-one rule).
- Frontmatter holds SRS state (`interval`, `ease`, `reps`, `next_review`).
- Body is plain markdown — no app-specific syntax.
- Stable string `id` is the filename (e.g., `os-2026-06-08-page-replacement-lru.md`).
- The `INoteStore` interface is the only contract — no code should touch SQLite or files directly outside the store implementation.

Open questions to resolve in Task #2:
- ID scheme (timestamp? topic-prefix-slug? user-defined?)
- Subject taxonomy (free-form string, or enum?)
- How to represent the "connect" link (plain markdown text in body, or a structured `links: []` frontmatter field?)
- Schema versioning strategy for future migrations
