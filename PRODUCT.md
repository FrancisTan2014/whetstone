# Product brief

## Vision

whetstone is a personal reading app for turning source materials into a connected, contextual
knowledge library.

**North Star:** build my personal knowledge library — read source materials, break them into
addressable atomic units, attach notes to specific passages, and connect ideas across works.

## v0 scope

1. **Ingest** source materials — by manual input and by file upload (`.md`, `.epub`) — and have the
   backend automatically decompose them into the content model below.
2. **Read** materials in a clean continuous reader.
3. **Annotate** — select any text (a word, phrase, or longer passage) to create a note anchored to
   the exact source block.
4. **Find** — search across the library at block granularity.

Manual input remains a first-class v0 path; file upload exists because manually typing a whole work
(e.g. 《史记》) is infeasible.

### Usable v0 first (walking skeleton)

The first milestone is a **thin but complete, usable end-to-end loop** — not a set of polished
features. Build this whole thread before thickening any single part:

1. Create or select a Work.
2. Add content (manual Markdown or `.md` upload) -> blocks.
3. Read it in the reader.
4. Select text -> write a note.
5. See your notes.

Defer until the loop is usable end-to-end: EPUB/PDF ingestion, re-ingestion with stable-id
preservation, Markdown export, reader highlights and rich note management, search polish, and any
template breadth beyond the seeded set. A usable app beats a complete feature.

## v0 stack direction

- Web-core TypeScript stack, to maximize OSS leverage for parsing, rendering, selection, annotation,
  and future rich connections.
- Browser target: PWA. Mobile (later): Capacitor wrapper. Desktop (later): Tauri wrapper.
- v0 is server-centered: thin clients talk to one server. Client storage (IndexedDB) may be a later
  cache, never the v0 source of truth.
- Backend: Node.js TypeScript + Fastify + PostgreSQL (via Drizzle). Validation with Zod. Tests with Vitest.
- **The PostgreSQL database is the source of truth for content.** Content is stored as discrete
  **Block** rows (see content model); Markdown is an import/export format, not the stored form.
- The **original uploaded file** (`.md`/`.epub`/later `.pdf`) is retained on the server filesystem /
  object storage for provenance and re-ingestion (path + sha256 recorded in the database). It is not
  the source of truth; the decomposed blocks are.

## v0 design language (UX)

The product feel is **calm, focused, scholarly** — sharpen your mind against the text. One coherent
design system, built for cross-platform from the start (web-core -> Capacitor -> Tauri). Detailed
tokens live in code (the Tailwind theme) once built; this section records the durable decisions.

- **Identity:** a warm "paper" reading surface framed by a quiet app shell; a single **ink-indigo**
  accent for all interactive elements; **three muted annotation hues** mapped to the note templates —
  Vocabulary (amber), Expression/phrase (teal-green), Thought/question (violet).
- **Typography:** **serif** reading body (Latin: Source Serif 4; CJK: a Song/Serif stack for
  classical texts) with **sans (Inter)** for UI; language-aware font stacks; a fixed reading measure
  (~66ch Latin, narrower and looser-leading for CJK); user-adjustable reading text size.
- **Themes:** ship **Day (light)** and **Night (dark)**; Day is the default with a Night toggle. Dark
  mode is a token override, never a second set of components.
- **Information architecture:** one unified single-user app with four modes — **Library, Reader,
  Notes, Search**. Ingest is contextual (add or upload from a Work), not a separate "admin" site;
  "admin" and "reader" remain one person in different modes.
- **Navigation:** a left sidebar on desktop/tablet and a bottom tab bar on mobile; the reader is
  immersive (chrome recedes while reading).
- **Motion (first-class):** the app should feel **lively** — purposeful, spring-based motion in the
  chrome, transitions, and the moment of annotation (a note's highlight is "born" on save) — while the
  **reading surface stays calm**. Motion is tokenized and honors reduced-motion.
- **Cross-platform:** responsive and adaptive by capability; safe-area- and `dvh`-aware layout;
  gestures work for touch, mouse, pen, and keyboard; color tokens ship with fallbacks for older
  WebViews; the active theme drives native chrome. The server stays the source of truth (no offline
  authority in v0).
- **Always:** explicit empty/loading/error states, AA+ contrast, visible focus, and >=44px touch
  targets.

## v0 content model

- The durable domain object is `Entry`. Materials, reading units, blocks, and notes are all entries.
- Relationships between entries are typed links. v0 link types: `contains`, `annotates`,
  `references`, `related_to`. (`references`/`related_to` are reserved for future cross-work
  connections and are inert in v0.)
- Content hierarchy: `Author/Source -> Work -> ReadingUnit -> Block`.
  - `Author/Source` is a relational entity, selected from a list or created inline. (May be filled
    automatically from uploaded file metadata.)
  - `Work` is a readable work; v0 type is `book`, `essay`, `blog_post`, or `classical_text`; it has a
    language field inherited by its units. v0 supports three languages, stored as fixed codes chosen
    from a dropdown (no free-text): Simplified Chinese (`zh-CN`), Traditional Chinese (`zh-TW`),
    and English (`en`). EPUB metadata languages are normalized into this set on ingestion.
  - `ReadingUnit` is an ordered unit within a work (chapter/section/essay). It is a container/ordering
    entry, linked from the Work via `contains`.
  - **`Block` is the atomic, addressable unit** — one Markdown block (paragraph, heading, list item,
    blockquote, code block). Each block is an `Entry`, linked from its ReadingUnit via `contains`,
    with a **stable id** that survives edits and re-imports. Blocks are what notes anchor to and what
    search returns.
- A short work (essay, blog post) has one ReadingUnit; a book/classic has many ordered units.

Examples: Charles Dickens -> A Tale of Two Cities -> chapters -> paragraphs. George Orwell ->
Politics and the English Language -> one unit -> paragraphs. 司马迁 -> 史记 -> ordered
chapters/passages -> blocks.

### Stable block ids

- On first ingestion, each block row gets a stable id (UUIDv7 or cuid2).
- On re-ingestion of an edited source, a content-similarity diff matches existing blocks to new ones
  and **preserves ids for matched/lightly-edited blocks**, so existing note anchors keep working;
  only genuinely new blocks get new ids. Removed blocks are soft-deleted, keeping anchors valid.
- Content-hash ids (break on any edit) and positional ids (break on insert) are explicitly rejected.

## v0 content ingestion

Ingestion is a single boundary with pluggable **format adapters** that all normalize to the same
intermediate (Markdown AST / mdast), which a shared step decomposes into ordered `Block` entities
with inferred `ReadingUnit` boundaries and metadata:

```
upload/input -> adapter (md | epub | …) -> mdast -> Block entities (+ ReadingUnit, metadata)
```

Staged by difficulty and value:

- **v0 — Markdown**: manual input and `.md` upload. Parsed with remark into blocks. One Work / one
  ReadingUnit by default; headings infer further structure.
- **v0 — EPUB**: `.epub` upload. The structured spine gives reading order; the OPF gives title /
  author / language; each chapter's XHTML becomes a ReadingUnit of blocks. **This delivers the
  whole-book case (史记) without manual typing.**
- **Next stage — PDF / scanned**: deferred. Handled by an **isolated Python ingestion worker**
  (document-AI + CJK OCR) behind the same normalized contract, opened only when its fidelity gain is
  worth the added runtime. Not part of v0. (See future direction.)

Re-ingestion is idempotent: the original file's sha256 is recorded; re-upload replaces the work's
blocks via the stable-id diff above, inside a transaction.

## v0 reader

The reader is **目录-driven and reading-unit-scoped**, mirroring how mature readers (EPUB spine readers,
微信读书) work and avoiding the freeze of rendering a whole book at once.

- **Navigation by table of contents (目录).** A TOC lists the work's reading units in order (current one
  highlighted); selecting one opens it — a sidebar on desktop/tablet, a drawer on mobile. A single-unit
  work (a short essay) needs no TOC.
- **One reading unit at a time.** The reader renders only the **current reading unit's** blocks, as a
  continuous vertical scroll within that unit — not the whole work concatenated. Rendering stays bounded
  regardless of book size (a whole book is thousands of blocks; one chapter is hundreds); this is what
  every mature reader does (load one spine resource, not the entire book).
- **Scroll within a chapter; chapter breaks between.** This hybrid matches reading-comprehension research
  for technical/reference material. **Page-flip pagination is a planned later mode** (evidence shows
  pagination aids recall for dense material), not v0.
- **Reading position is remembered** (current unit, plus best-effort scroll offset), so reopening a work
  resumes where the reader left off ("Continue reading"). Position is client-side UI state (localStorage),
  never a server source of truth.
- A subtle **progress indicator** shows place in the work; the reader is immersive (chrome recedes while
  reading).
- Markdown is rendered safely — no raw/unsafe HTML execution. Each rendered block carries its block id so
  selection maps deterministically to a block.
- Empty / loading / error states are explicit.

### Reader readability

A real book has lists, code, tables, footnotes, and blockquotes — not just prose — so block rendering must
be clean and consistent:

- Even vertical rhythm; no cramped walls of text. Lists render as lists (markers + indentation), not
  flattened paragraphs.
- Code blocks use monospace on a distinct surface; inline code is distinguished. Tables,
  blockquotes/epigraphs, and footnotes are styled for readability.
- Front matter (title/copyright/dedication units) is de-emphasized, not rendered as giant repeated
  headings.
- Typography targets: reading measure ~66ch (Latin), line-height >= 1.5, comfortable body size (~18px),
  user-adjustable; warm paper surface (not pure white). Day/Night now; paper/eye-care themes later.

## v0 note capture

- Users can select any text range in the reader — a single word, a phrase, or a longer passage.
- A note is an `Entry` linked to the selected source via `annotates`.
- The anchor stores the **block id** plus, for sub-block selections, a character offset range within
  that (small, stable) block, the selected-text snapshot, and a surrounding-context snapshot.
  Anchoring to a stable block id (not a whole-file offset) keeps notes durable across edits.
- Selecting text opens the note editor as a side panel on desktop-width screens and a bottom sheet on
  narrow screens. The selection toolbar/popover must not obstruct the selected text and snaps to
  word/sentence boundaries. Selection within a single block is sufficient (cross-block selection is not
  required, matching mature readers). Desktop **marginalia** (notes aligned in the wide margin) is a
  planned later enhancement.
- A note contains the selected-text snapshot, the chosen template, structured answers, and the
  rendered Markdown note body.

## v0 note review

The capture loop is only half the value; v0 also lets the user get notes back:

- Annotated blocks are **visually highlighted** in the reader; selecting a highlight reopens its note.
- A simple per-work / per-reading-unit **note list** lets the user revisit notes.
- Notes can be edited and deleted.

## v0 note templates

The note editor uses structured templates. After selection, the editor shows a template selector and
may preselect a likely template; the user can switch before saving.

Templates are database-seeded rows (no admin template editor in v0). Storage:

- Template rows store ordered `fields_json`; v0 field types are only `short_text` and `long_text`.
- Note entries store structured `answers_json` keyed by template field id.
- The Markdown note body is rendered from the template + answers (derived output, not the only store).
- Template JSON is a small controlled shape (not arbitrary UI code), so future field add/remove is safe.

Initial templates:

1. **Vocabulary** — Meaning in this context; My explanation or translation; Memory hook; Example I might use.
2. **Expression / phrase** — What the phrase is doing; Why it sounds useful; My imitation sentence.
3. **Thought / question** — What I noticed; Why it matters; Question or connection.

Preselection by selection size (concrete thresholds, so the developer does not invent them):

- 1 word -> Vocabulary.
- 2–6 words -> Expression / phrase.
- more than 6 words -> Thought / question.

## v0 search

Search runs over block text at block granularity (results point to the exact block):

- **v0**: PostgreSQL full-text search (`tsvector` + GIN) for Latin-script, plus `pg_trgm` (trigram)
  for fuzzy/substring — `pg_trgm` also gives usable substring search over CJK without word
  segmentation. Both are Postgres-native; no external service.
- **Later**: app-side CJK word segmentation (jieba) feeding `tsvector` for ranked Chinese FTS.
- **Later**: `pgvector` multilingual embeddings for semantic "related ideas/blocks" search.

Storing blocks as rows makes search easier and richer than files would (granular, indexed, ACID).

## v0 vocabulary lookup

While reading, the user can select a single word (or short phrase) and look up its meaning in place —
a fast, **view-only** glance that never auto-creates or edits a note. Note-taking stays a deliberate,
manual act (the effortful encoding is the point); lookup only removes the friction of finding a meaning.

- **Boundary first.** Every lookup goes through a `DictionaryProvider` interface
  (`lookup(term, language) -> NormalizedEntry`) that hides each source's format, transport, and caching.
  Providers are pluggable; the reader UI is identical across them.
- **Normalize and trim.** Raw dictionary results are long and messy, so each provider has an adapter
  that normalizes to a compact shape — headword, optional pronunciation, and a few concise senses
  (part of speech, gloss, optional example) — capped so the popover stays scannable.
- **English source:** Merriam-Webster's **Learner's Dictionary API** (server-side key, attribution,
  non-commercial), with the no-key **Free Dictionary API** (Wiktionary-sourced) as a fallback.
- **Chinese source:** the openly licensed **CC-CEDICT** (pinyin + gloss); for classical depth, the
  **public-domain** source dictionaries (《康熙字典》, 《说文解字》) may be added as further providers.
  Copyrighted sites with no open license or API (e.g. Oxford, Longman, 汉典/zdic) are not scraped.
- **Surface:** a popover on desktop-width screens and a bottom sheet on narrow screens, consistent with
  the note editor.
- **Server-centered:** the API key stays on the server; results are cached to respect rate limits.

A future **LLM provider** behind the same interface can give context-aware meanings (and classical
Chinese, where dictionaries are weak) and, separately, draft a note the user must edit — both remain
future, not v0. Lookup does not change the "No LLM note drafting" non-goal.

## v0 technology choices (locked)

- Markdown parsing / serialization: `remark-parse` + `remark-gfm` + `remark-stringify` (mdast).
- EPUB parsing: `@lingo-reader/epub-parser`; chapter XHTML -> mdast via `rehype-parse` + `rehype-remark`.
- Safe rendering: `react-markdown` + `rehype-sanitize` (no `dangerouslySetInnerHTML`; per-block
  `data-block-id`).
- Search: PostgreSQL FTS + `pg_trgm` now; `pgvector` later (Drizzle has native `vector()` support;
  `tsvector` is set via raw SQL).
- All chosen libraries are permissively licensed (MIT/Apache/BSD).

## Future direction protected by v0

- The Entry/link + Block model supports future rich connections between materials, notes, concepts,
  and review items (block references, backlinks, transclusion) — none built in v0.
- **PDF / scanned ingestion** via an isolated Python document-AI worker (e.g. Docling + PaddleOCR),
  with admin review of extracted content. Permissive licenses only; AGPL/GPL tools avoided.
- Semantic search (`pgvector` embeddings).
- A block-based editor (future), language-learning durability/memorization, and LLM-assisted note
  drafting remain future, not v0.

## v0 non-goals

- No block-editor UI (v0 edits content by re-ingestion; in-place block editing is future).
- No spaced repetition, memorization scheduling, or AI grading.
- No LLM note drafting.
- No voice or audio features.
- No daily routine; no complicated settings.
- No PDF/scanned ingestion in v0 (it is the next stage, not a permanent exclusion).
- No authentication or multi-user behavior (v0 is single-user; "admin" and "reader" are one person in
  different modes).
- No social reading (shared highlights, friends' notes, comments) or gamification (streaks, rankings,
  reading-time competitions).

## Glossary

- **Source material**: text ingested (by input or upload) and read in the app.
- **Block**: the atomic, stably-identified content unit (one Markdown block); notes anchor to blocks
  and search returns blocks.
- **Reader**: the page that displays a Work's blocks for reading and note capture.
- **Linked note**: a user note attached, via `annotates`, to a selected block and location.
- **Ingestion**: decomposing an input/uploaded source into the Author/Source -> Work -> ReadingUnit ->
  Block model.
