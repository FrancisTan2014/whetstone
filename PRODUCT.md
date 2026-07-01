# Product brief

## Vision & North Star

whetstone is a personal, **LLM-coached self-learning environment**. You do the learning — read, note,
write, and (later) speak; whetstone collects your activity into a **durable, structured learning history**
and, leveraging the LLM through a purpose-built context architecture, gives **proactive, personal, deep**
suggestions and fast feedback. Unlike stateless single-shot chat, the coach is conditioned on everything
you have read, noted, gotten wrong, and connected — so it can advise in a way generic chat structurally
cannot.

**The principle:** the coach **proposes and connects — it never does your understanding for you.** You stay
the learner; the LLM is the always-available tutor a solo learner otherwise lacks. The moat is not "the LLM
sees everything" (that hits the context wall) but the **learner model + retrieval** that assembles the right
slice of your history for each suggestion. Reading is the on-ramp, not the destination.

**The final goal is growth, not activity.** whetstone is a **self-betterment instrument**: the learner model
exists not to log what you did but to **change you** — to move what you encounter from effortful and translated
to **owned, automatic, and used in real life**. Success is judged by **internalization and growth** (transfer,
retention, real-world use), never by streaks or volume. Language is v0's **first proving ground**; the
architecture — capture → model → push → internalize → grow — is domain-general. The name says it: you sharpen
*yourself* against the text.

**因材施教 — for everyone.** Confucius taught *to the student*; but a tutor who reads one learner and adapts to
them was, for most of history, a privilege of the rich. The LLM makes **因材施教 universal** — a patient tutor
that knows *your* gaps, *your* materials, *your* energy. That democratization is whetstone's reason to exist.

**The scope test (so the app cannot sprawl into a mix):** every feature is either
- **(a) capture** — it records your activity/knowledge into the structured learner model, or
- **(b) coach** — it is the LLM reading that model to give feedback, suggestions, or connections.

If a feature is neither, it is out of scope.

**The spine — one model, many views.** There is **one learner model**, with two planes around it: a **shared
source library** (what you read — ingested works/blocks, no owner) and your **personal trace** (what you've
done — notes, diary, speech-practice deposits, recall — all `user_id`-owned, all feeding the model). Capture
types differ only by **anchoring**: a note → a source block, a speech deposit → a case, a diary entry →
un-anchored. Every personal surface is a **view of the one model** — **Today** (what's next), the fog-of-war
**Map** (mastery), **Recall** (what's due), a **Timeline** (history, newest-first) — so "history" is a *view of
your trace*, never a per-feature page (the diary's history is the Timeline's first facet). **Reading is the
on-ramp; the model is the destination.** The model compounds only as fast as it is fed, and the **feed
(capture) side is deliberately thin in v0** — it is the growth frontier (see "Future direction → more feeders").

## Internalization & growth (the back half of the loop)

The loop is **capture → model → push → internalize → grow** — the first three are machinery, the last two are
the point. v0's back half is **thin**: the app measures and schedules *in-app performance* (intervals, case
scores, mastery) but under-verifies **internalization** and barely reflects **growth**. The strict test it
mostly skips is **transfer**: you have internalized something when you deploy it **spontaneously in a situation
you were never drilled on** — ultimately, in real life. Four principles correct this — each a *sharpening of an
existing surface*, not a new app:

- **Ownership = transfer, not interval.** A chunk counts as owned (lit on the Map) only when produced
  **unprompted in a context it was not taught in**; the coach deliberately probes transfer. Mastery is
  *demonstrated*, not *scheduled*.
- **Close the loop to life.** Pair the "I couldn't say X" feeder with its mirror, **"I used X for real"** — the
  truest internalization signal and the truest growth metric.
- **Reflect becoming, not doing.** The Timeline matures from a log into a **growth arc** (was-weak → now-owned,
  latency down, range up); seeing growth reinforces it (metacognition) and is the "better person" made visible.
- **Push by internalization value** — due × real-life value × *not-yet-transferred*, not mere due-ness.

These are **principles, not v0 scope**: v0 stays the small assistant; they fix what every surface is *for* and
how to judge it — by internalization and growth, not activity.

## The arranger — guidance as the product

The hardest part of self-learning is often not capability or even discipline; a committed learner can still get
only **single-dimensional, generic guidance** from stateless chat, which re-meets them every prompt. whetstone's
moat — your learner model + history + **persona** — exists to give what chat structurally cannot:
**multi-dimensional, persona-grounded guidance.** This is 因材施教 applied to your *life path*, not just your
vocabulary, and it is the arranger's real job: turn big, long-horizon goals into a **disciplined daily routine**.

**The model is of you and your goals — as tracks.** Parallel tracks (a language, a craft, a domain to master, an
early-childhood track…) each carry an **aim-high 上 goal → a persona-grounded path → today's small slice**.
取法乎上，得乎中. The day is the unit; **10 minutes a day beats a 3-hour weekend**; consistency compounds. The
arranger projects each track's daily slice onto the Today board.

**Planning is hybrid — never autonomous, never absent.** The arranger **proposes a persona-grounded path draft**;
you **approve or edit** it; then it **owns the daily cadence and progress** against that path. Keeping you in the
loop is what stops it drifting into the generic advice stateless chat gives — the plan is *grounded in your model
and ratified by you*, not generated blind.

**It defends against discouragement by design — not by mood.** Discouragement attaches to an *uncertain outcome*;
the routine converts it into **controllable daily action** and resets the scoreboard: the 上 may be a goal you can
be denied, but the **guaranteed 中 is who you become** — disciplined, capable, confident. This is the telos in
operation (*growth, not activity*): aim high, and let the daily practice guarantee the growth regardless of the
verdict.

The arranger then reframes the **Today home**: not a feed of proposals but a **finite, clearable daily board** —
clear it, then rest freely, *no back-judge*. Supporting constraints keep it humane, never a new boss:

- **Compassion, never punishment.** No shame, no punishing streaks; a missed day or a low-energy week is
  *recovered from*, treated as **energy data, not a moral failure** (this is *why* v0 rejects streaks and
  gamification).
- **Small & compounding over intensity.** Size the day to be clearable *even on a low day* — `(1.01)^365`, not
  heroic bursts that collapse.
- **Energy-aware & relapse-tolerant.** Low energy *shrinks* the board, offers lighter work, or blesses rest; it
  bends, it does not break.
- **Scaffolding that fades.** It externalizes discipline *until the habit is internalized*, then steps back —
  growing your capacity to self-direct is itself part of growing into a better person.

**Breadth = the whole 六艺, language first.** The arranger is meant to span the whole curriculum and is
**domain-general by design**, but v0 **proves the pattern on one track (language)**, built **track-aware** so other
tracks slot in cleanly. The multi-track life arranger is the vision; one disciplined track, end to end, is v0.

**v0 is a usable personal learning assistant — not only the on-ramp.** The reading + annotation loop is the
*on-ramp* that begins the learner model (read source materials, break them into addressable blocks, attach
notes, connect ideas across works). v0 now also delivers the **assistant loop the North Star promises**: a
proactive **Today home** that **captures** (a tap-and-talk voice diary), **proposes recall** (due items from
the built SM-2 scheduler), and **surfaces practice** (the reading→practice nudge). The coach/recall *engine*
(SM-2, recall store, the live coach, the learner model, the fog-of-war map) is **already built** — v0 adds the
**proactive surfaces** that make it usable. The reading surface itself stays calm; the assistant lives in its
own home (see "v0 assistant home (Today)"). The detailed scope and content model below remain the source of
truth for what to build now.

## v0 scope

1. **Ingest** source materials — by manual input and by file upload (`.md`, `.epub`) — and have the
   backend automatically decompose them into the content model below.
2. **Read** materials in a clean continuous reader.
3. **Annotate** — select any text (a word, phrase, or longer passage) to create a note anchored to
   the exact source block.
4. **Find** — search across the library at block granularity.
5. **Capture by voice** — a tap-and-talk **voice diary**: each voice note is transcribed, lightly **tidied
   (never polished)**, and saved as a **block under the current date**, deposited into the learner history
   the coach reads.
6. **Recall** — surface **due** items (the built SM-2 scheduler) as **gentle, capped, snoozeable proposals**;
   completing one feeds its grade back to the scheduler.
7. **A proactive Today home** — the assistant's front door, composing capture + recall + the
   reading→practice nudge; it is the app's landing. The reader stays calm (none of this lives in it).

Items 1–4 are the **on-ramp**; 5–7 are the **assistant loop** over the already-built coach/recall engine
(see "v0 assistant home (Today)" and "Language practice & recall").

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
  **Block** rows carrying the **ProseMirror/Tiptap document node** (see "Architecture" below);
  Markdown/mdast is an import/export format, not the stored form.
- The **original uploaded file** (`.md`/`.epub`/later `.pdf`) is retained on the server filesystem /
  object storage for provenance and re-ingestion (path + sha256 recorded in the database). It is not
  the source of truth; the decomposed blocks are.

## Architecture: the document-model bedrock (committed)

whetstone's content representation is a **schema-based block document** — the ProseMirror model,
adopted via **Tiptap** (MIT) — replacing the earlier **mdast** (a Markdown AST), which silently dropped
real publisher constructs (figure, definition list, callout, footnote) and is now **import/export
only**. Chosen after a verified deep dive: ProseMirror is Atlassian-grade but its own repos are
archived, so we consume it through the actively-maintained MIT **Tiptap**. (BlockNote rejected —
MPL-2.0 core + GPL-3.0 packages; Lexical rejected — not a block-document model. No paid Tiptap Pro
features used.)

**One model is the spine; every capability is an expression of it** — ingest writes the doc, the editor
writes it, the reader renders it, notes/comments/connections decorate it, "share a card" renders a
slice. Validated against essays, comments, ebook ingest, social cards, and cross-work (cross-language)
connections — each reuses the same primitives: **addressable blocks + an external personal relation +
decorations**.

Four layers:

1. **Ingestion (server + jsdom).** Source HTML (EPUB; later PDF→HTML via Docling) → PM doc via each
   node's `parseDOM`. **Fail-loud invariant:** ProseMirror's DOMParser silently descends unknown tags,
   so a pre-parse walk + the `ruleFromNode` intercept wraps any unrecognized element in a conservative
   **`unknown`** node (raw subtree preserved) and emits a **structured evidence log**
   (tag/attrs/location/neighbours). Nothing is silently dropped; the logged gaps are the backlog that
   drives schema growth.
2. **Storage (Postgres, source of truth).** `prosemirror-model` runs in Node (the JSON path is pure;
   jsdom is needed only at HTML import). Content stays **decomposed block rows** (right for per-block
   notes, reading position, and search) carrying the PM node + a **stable node id** (Tiptap UniqueID).
   Ingested content is regenerable from the retained source; **authored** content (essays) is itself
   canonical.
3. **Reader.** `@tiptap/static-renderer` renders the PM doc to React/HTML **without a browser**,
   replacing the mdast→hast renderer; the same doc becomes editable later (Notion-like blocks).
4. **Annotation.** Notes, marks, comments, and connections live **outside** the content doc
   (personal data, `user_id`) and render as ProseMirror **Decorations** — never marks (marks would
   contaminate shared content and die on re-ingest). Anchors are block-id + offset with a **W3C
   TextQuote fallback** (Hypothesis / apache-annotator, BSD/Apache) so they survive edits and
   re-ingestion; cross-block ranges are native in PM's flat positions. **Connections** across works
   (including cross-language) are the same anchor pointing at two blocks.

**No migration** — there is no real data yet (in-memory dev runs), so this is a **clean build on the
new bedrock**, not a migration. Deprecated and replaced: mdast as the stored form, the hand-rolled
HTML→mdast figure/dl/callout/footnote detection, the mdast→hast renderer, and the hast-tree-walk
highlight application. Permissive licenses only (MIT/Apache/BSD); no GPL/AGPL, no paid lock-in.

## v0 design language (UX)

The product feel is **calm, focused, scholarly** — sharpen your mind against the text. One coherent
design system, built for cross-platform from the start (web-core -> Capacitor -> Tauri). Detailed
tokens live in code (the Tailwind theme) once built; this section records the durable decisions.

- **Identity:** a warm "paper" reading surface framed by a quiet app shell; a single **ink-indigo**
  accent for all interactive elements; **three muted annotation hues** mapped to the note templates —
  Vocabulary (amber), Expression/phrase (teal-green), Thought/question (violet).
- **Typography:** **serif** reading body (Latin: Source Serif 4; CJK: a Song/Serif stack for
  classical texts) with **sans (Inter)** for UI; language-aware font stacks;   a ~66ch reading measure
    (Latin; narrower, looser-leading for CJK) held at a **stable column width**, so adjusting the text
    size reflows the text rather than widening or narrowing the column.
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
  - **`Block` is the atomic, addressable unit** —   one content block (paragraph, heading, list item,
      blockquote, code block, **table**, or **figure** — an extracted EPUB image with its caption). Each block is an `Entry`, linked from its ReadingUnit via `contains`,
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

## Identity & ownership (v0)

- **Content is shared library; personal activity is user-owned.** Works, reading units, blocks, and
  sources are global content (no owner). Notes, reading position, and future personal signals (highlights,
  the learner model) are **user-owned** and carry a `user_id`.
- **One default identity, no auth.** v0 has a single `DEFAULT_USER_ID` resolved by one **current-user
  provider**; every personal write is stamped and every personal read is filtered through it. There is no
  `users` table, login, or session in v0.
- **Future migration is additive:** real multi-user swaps only the provider and adds a `users` table +
  foreign keys; existing personal rows are already keyed, so no retrofit/backfill of ownership is needed.

## v0 content ingestion

Ingestion is a single boundary with pluggable **format adapters** that map each source onto the
**ProseMirror/Tiptap document** (see "Architecture: the document-model bedrock"): source HTML → document
via per-node `parseDOM`, fail-loud (an unrecognized element becomes an `unknown` node + an evidence log
record, never silently dropped). A shared step decomposes the document into ordered `Block` rows (the
ProseMirror node + a stable id) with inferred `ReadingUnit` boundaries and metadata:

```
upload/input -> adapter (md | epub | …) -> ProseMirror document -> Block rows (+ ReadingUnit, metadata)
```

(The earlier mdast-intermediate pipeline is superseded — see `docs/DECISIONS.md` D1.)

Staged by difficulty and value:

- **v0 — Markdown**: manual input and `.md` upload. Parsed with remark into blocks. One Work / one
  ReadingUnit by default; headings infer further structure.
- **v0 — EPUB**: `.epub` upload. The structured spine gives reading order; the OPF gives title /
  author / language; each chapter's XHTML becomes a ReadingUnit of blocks. **This delivers the
  whole-book case (史记) without manual typing.** Images are extracted into **figure blocks** from EPUB
  `<figure>` structure (image + `<figcaption>`): the caption becomes the figure's caption, never a stray
  heading. A bare `<img>` becomes an image-only figure; v0 does not guess captions from neighboring text.
- **Next stage — PDF / scanned**: deferred. Handled by an **isolated Python ingestion worker**
  (document-AI + CJK OCR) behind the same normalized contract, opened only when its fidelity gain is
  worth the added runtime. Not part of v0. (See future direction.)

Re-ingestion is idempotent: the original file's sha256 is recorded; re-upload replaces the work's
blocks via the stable-id diff above, inside a transaction.

## v0 reader

The reader is **目录-driven and reading-unit-scoped**, mirroring how mature readers (EPUB spine readers,
微信读书) work and avoiding the freeze of rendering a whole book at once.

- **Navigation by table of contents (目录).** A TOC lists the work's reading units in order (current one
  highlighted); selecting one opens it. The 目录 is a **toggle/drawer on all widths** (it slides over/in and
  dismisses) — **not** a persistent column that competes with the text. A single-unit work (a short essay)
  needs no TOC.
- **One reading unit at a time.** The reader renders only the **current reading unit's** blocks, as a
  continuous vertical scroll within that unit — not the whole work concatenated. Rendering stays bounded
  regardless of book size (a whole book is thousands of blocks; one chapter is hundreds); this is what
  every mature reader does (load one spine resource, not the entire book).
- **Scroll within a chapter; chapter breaks between.** This hybrid matches reading-comprehension research
  for technical/reference material. **Page-flip pagination is a planned later mode** (evidence shows
  pagination aids recall for dense material), not v0.
- **Reading position is remembered and durable** (current unit + a best-effort block anchor), so reopening
  a work resumes where the reader left off ("Continue reading") across sessions and devices. Position is
  **user-owned state persisted on the server** (per current user + work); localStorage may remain a
  same-device cache, but the server is the source of truth.
- **Reading preferences are remembered and durable** (text size, Day/Night theme — and future reader
  settings). Like reading position, they are **user-owned state persisted on the server** (per current
  user, work-independent) so a reader's chosen size and mode follow them across sessions and devices;
  localStorage stays a same-device cache for instant first paint (no theme flash). One extensible
  preferences record, so new settings join without a new surface.
- **Immersive, single-column layout (微信读书-style).** Reading is full-bleed and calm: one reading column
  on the paper surface, **comfortably sized and framed by the edge chrome** (not a narrow column lost in
  whitespace). On **desktop** the reading **tools are a persistent right-edge vertical rail of icons** that
  stays put while scrolling (always one click away) and the **目录 a left drawer**; on **mobile** the chrome
  **recedes while reading** and is **toggled by tapping the center**. Tools are **icon-based** (the table
  of contents is a labelled **icon**, not the literal "目录" text). There is **no in-reader work-picker and no
  page heading**; a work is opened from the Library (or "Continue reading"). A subtle **progress indicator**
  shows place in the work. Chapter-to-chapter movement is a **foot-of-chapter pager** (Previous / Next
  with the adjacent unit title) below the text, alongside the 目录, so navigation never depends on the menu.
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
- **Code callouts** (the ❶ ❷ ❸ markers technical books attach to code lines, paired with an
  explanation list) keep the listing **one cohesive code block**: markers become inline circled-number
  text at their position (verbatim whitespace preserved), never shattering the block into figures.
  Non-interactive in v0 (no marker→explanation jump).
- **CJK microtypography.** Digitized Chinese sources often carry stray ASCII spaces between characters
  (scan line-wrap noise, e.g. `六 爻`, `然后 两仪`). Ingestion normalizes them away — an ASCII space
  flanked by CJK on both sides is removed (Chinese has no inter-word spaces); spaces touching Latin/digits
  and spaces inside verbatim code are kept. Not a fidelity loss (a space between two Han characters is not
  a publisher construct); the raw source EPUB is retained.
- **Figures** (EPUB images) render as a real figure — the image sized to the reading measure with its
  caption beneath (never a stray heading); a missing or unsupported image degrades to its caption alone.
  The image is display-only (not annotatable); its caption is selectable text you can take notes on.
  **Tapping or clicking the image opens it larger in a lightbox** — a centered overlay that fits the image
  to the viewport over a dimmed backdrop, dismissed by Escape, the backdrop, or a close button (it never
  navigates away) — so diagrams and dense figures stay legible beyond the reading column.
- Front matter (title/copyright/dedication units) is de-emphasized, not rendered as giant repeated
  headings.
- Typography targets: reading measure ~66ch (Latin), line-height >= 1.5, comfortable body size (~18px),
  user-adjustable text size that **reflows within a stable column width** (the column does not grow or
  shrink with text size); warm paper surface (not pure white). Day/Night now; paper/eye-care themes later.

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

While reading, the user can select a single word (or short phrase) and look it up in place — a fast,
**view-only, monolingual** glance that never auto-creates or edits a note. Note-taking stays a deliberate,
manual act (the effortful encoding is the point), and the *meaning-mapping stays the reader's own work*:
lookup shows real dictionary content, not a pre-digested analysis.

- **Boundary first.** Every source implements a `DictionaryProvider` interface that hides its format,
  transport, and caching. A small **lookup service composes** providers into one `DictionaryEntry`; the
  reader UI is identical across sources.
- **Monolingual English (EN -> EN), from trustworthy free sources, composed by role:**
  - **WordNet** (Princeton; bundled offline via an npm package such as `wordpos`) — the **reliable
    backbone**: it works with no network and supplies authoritative **synonyms** and a sense fallback.
  - **Free Dictionary API** (Wiktionary-sourced; no key) — the **rich layer**: pronunciation/IPA, example
    sentences, and etymology, and the primary sense source when reachable.
  - We **compose by role** (pronunciation/examples/etymology from Wiktionary; senses primary from
    Wiktionary with **WordNet fallback**; synonyms from WordNet) — we do **not** align individual senses
    across sources. **Merriam-Webster is dropped** (distrusted, commercial, keyed).
- **Chinese source:** the openly licensed **CC-CEDICT** (pinyin + gloss), rendered in the same layout.
- **`DictionaryEntry` shape:** headword, pronunciations (IPA/audio), **parts of speech each grouping
  ordered senses** (definition, examples, synonyms), optional etymology, and source attribution. It is
  ephemeral (not stored); results may be **lightly cached** to respect the Free Dictionary host.
- **Presentation — like a mature online dictionary.** A compact **popover** near the selection (desktop)
  / bottom sheet (mobile): **part-of-speech groups as tokenized, color-coded sections** (Day/Night-aware,
  consistent with the design system), **numbered senses** with indented examples, **synonyms** as chips,
  a quiet **etymology** section, and a **sources** footer; clear hierarchy and white space; scrolls for
  long entries.
- **External dictionary jump-outs, and the not-found fallback.** Every entry deep-links to mature external
  dictionaries for the same term, **language-aware** (English → Longman / Merriam-Webster / Oxford; Chinese →
  汉典 / 萌典 / ctext / 国学大师). These are also the **not-found fallback**: when the bundled sources have no
  entry (common for compounds and proper nouns like 六爻), the panel offers these links instead of a
  dead-end — lookup never traps the reader, it always opens a path to real dictionary content. Outbound
  links only — never scraped or embedded.

**Interpret the selection before looking it up (CJK segmentation).** A raw CJK selection is ambiguous —
there are no word spaces — so a tap/selection is first *interpreted* into word spans: the reader snaps to
the segmented word under the tap (六艺, not 六) and can grow/shrink to the neighbouring token
(微信读书/Pleco-style), and lookup runs on that span. Driven by **native word segmentation**
(`Intl.Segmenter`, zero-dependency) — **not** an LLM sub-word (BPE) tokenizer, whose statistical pieces do
not respect word meaning; a classical-tuned segmenter (e.g. jiayan) is a later refinement.

**LLM explanation — narrow, labeled, context-grounded (never a dictionary).** The default lookup stays real
dictionary content the reader maps for themselves; an LLM pre-digest of ordinary vocabulary is shallow
("fake") learning and stays deferred (the "No LLM note drafting" non-goal holds). But where dictionaries
*structurally* miss — classical Chinese (文言文), 成語, allusions, proper nouns — the reader hits a dead end,
so lookup offers an **optional** "explain in context" tab: a **local LLM** (Qwen/DeepSeek, via the existing
coach model seam) glosses the selected span **using its surrounding sentence** — context a dictionary cannot
use. It is a **reference of last resort** — clearly marked AI-generated and attributed, never dressed as an
authoritative entry — and **off by default** (absent-config/fake-safe, so the gate is green with no model).
Classical Chinese first.

## v0 technology choices (locked)

- Content document model: **ProseMirror via Tiptap** (MIT) — see "Architecture: the document-model
  bedrock". Source HTML → document via `parseDOM`; `@tiptap/static-renderer` renders it; `prosemirror-
  model` runs in Node (per-block `data-block-id` from the stable node id).
- EPUB parsing: `@lingo-reader/epub-parser` provides chapter XHTML; Markdown import via `remark-parse`
  + `remark-gfm`. Both feed the document model (no longer a stored mdast intermediate).
- Search: PostgreSQL FTS + `pg_trgm` now; `pgvector` later (Drizzle has native `vector()` support;
  `tsvector` is set via raw SQL).
- All chosen libraries are permissively licensed (MIT/Apache/BSD); no GPL/AGPL, no paid lock-in.
- *Superseded* (mdast storage, `rehype-remark`→mdast, `react-markdown` rendering): see
  `docs/DECISIONS.md` D1.

## Language practice & recall (the learning loop)

The first capability built **on** the reading/annotation on-ramp: a coach that grows the learner's
*productive, everyday* English — the spoken vocabulary and ready-made phrasings a technical reader
rarely picks up.

**The gap it targets.** Outside a technical domain the learner thinks in their first language and
**constructs** each sentence by grammar instead of **retrieving** ready-made chunks — slow, effortful,
anchored to translation. Fluency is owning enough **chunks** (collocations, idioms, sentence frames) to
retrieve, not build. So the module trains **production under mild time pressure** (a situation → say it
before you can translate), not recognition.

**The compounding principle (the invariant).** *Every practice leaves a durable trace* — mistakes,
patterns kept, progress, corrections — deposited into the learner model; nothing is ephemeral. The
longer whetstone is used, the more deeply it knows the learner and the smarter its proposals get. This
is the moat (learner model + retrieval) made concrete, and the test for any practice feature: *does
this interaction make the next proposal smarter? If not, it leaks value.*

**The loop — a real-time spoken conversation.** A session (~15 min) is a **call with the coach**, not a
form. You tap once and **talk**; the coach listens continuously, detects when you've finished
(client-side endpointing), and **replies in voice** — back and forth, with **barge-in**, no buttons or
typing. Mid-conversation the coach **stays in flow**: it keeps you producing and offers **light repair
only on a real breakdown**, never grading every sentence (interrupting kills fluency). The screen is a
calm **call surface** — who's-speaking, live captions, the situation as quiet context, one **End**.

**End of round → the deposit.** The user ends, or the coach **lands the plane** (scenario resolved or the
time-box near). Then **one analysis pass** over the whole round (transcript + STT word-timings + the
case's target chunks + compiled context) returns a **structured debrief** — per-chunk grades, the 2–3
highest-value **pattern-tagged** mistakes, wins, one native upgrade — and that deposits
**deterministically** into SM-2 recall, error-pattern counts, the rolling profile, and case mastery (the
map). A compact **debrief screen** shows the few moments that matter and what is now due to recall. *Flow
during, learning after:* the conversation stays natural while every round still compounds.

**Voice plumbing (decided).** Voice-**in** = browser mic + lightweight client VAD → **server-side local
Whisper** (transcript + word-timings; private, swappable, cost-routed). Voice-**out** = the **browser's
built-in TTS** (free, on-device) for v0, a neural-voice seam later. The browser's own speech *recognizer*
is rejected (cloud-routed, unreliable on Safari/iOS, no timings). **The coach is a fixed skill that
evolves by briefing, not by rewriting itself:** each round `compileContext` feeds it your profile + due
chunks + top error patterns + recent outcomes, and the learner model sets **knobs** (target band,
challenge-vs-support, patterns to probe, register, pace) — the dossier grows, the skill stays fixed. A
self-tuning, eval-driven coach is deferred; the knobs are its seam.

**Division of labour (smart, bounded, cheap).**

- **Deterministic SM-2 schedules; the LLM grades** (judging production quality) and proposes next — the
  scheduling math never costs a token.
- **Content is bounded** to situations/domains the learner lacks, with chunk inventories **pre-cooked
  and reviewable** — the LLM authors into a stable corpus and judges against it; it never
  free-generates live.
- **The app is a thin orchestrator** over a rich **learner-context store** + a **model-agnostic LLM
  seam**: cheap/local model for the bulk, a stronger model only for the few coaching calls; **voice
  decoded locally with OSS** (transcript + prosody features → the LLM), never raw audio.

**Why production, and why spoken (the basis).** Input (reading) is necessary but not sufficient —
producing forces retrieval and reveals gaps (Swain's output hypothesis); automaticity is **skill- and
modality-specific**, so you automate speaking only by *speaking*, not typing (DeKeyser); and real-time
pressure builds the automatic access fluency needs (Segalowitz). Hence spoken, production-first, under
mild time pressure.

**Content navigation — a coach-navigated fog-of-war.** Everyday English is an **authored map** of
domains/cases (kitchen, chores, childcare, small talk, errands…) — the curation of *what matters*, with
no fixed linear path. The **coach lights the next region by `gap × frequency`** (high-value in real
life **and** still weak for you), **seeded by your real failures** (jots, reading captures, "I couldn't
say X"), and it **probes adjacent dark areas** to surface blind spots you couldn't nominate. Your
learner model drives the route; the map guarantees coverage.

**Progress & the feedback loop.** The map is the **learner model made visible** — lit = owned, dim = in
progress, dark = unknown — the honest progress signal (not XP). The system knows improvement by
**measuring every turn** (produced the target? naturally? how fast — STT latency/pauses? which error
category?) and reading the **trend in those deposits** (mastery intervals lengthening, error frequency
falling, latency dropping, dark→lit). Improvement is the model's *slope*, not a one-off test. This
closes a two-level loop — **micro** (speak → judge → next cue adapts) and **macro** (deposits →
model/map update → tomorrow's navigation + recall schedule) — at once how the system measures progress
and how it gets smarter.

**Settled vs open.** Settled: the gap/thesis and SLA basis, the compounding invariant + feedback loop,
deterministic-recall + LLM-grades, voice-first input, the fog-of-war content navigation, bounded
pre-cooked content, the thin-app + rich-context + cost-routed model seam, and **the real-time spoken talk
loop with its end-of-round analysis → deposit → debrief, the voice-in / voice-out plumbing, and
coach-evolves-by-briefing + knobs.** Settled too — the **proactive reading→practice nudge**: a recent
reading capture surfaced as a single, value-ranked (gap × frequency + recency), decaying, cooldown-gated
prompt on the **Today home** (and the Practice entry) — **never in the reader**,
no separate inbox, no push notifications. Open: pronunciation / prosody scoring, the neural-voice (TTS)
upgrade, a self-tuning (eval-driven) coach, and the reverse practice→reading "re-read pointer".

## v0 assistant home (Today)

The North Star is *proactive*, so v0 gives the assistant a **front door**: a **Today** home that is the app's
landing. It surfaces *what to do today* by reading the already-built learner model, and the **reading surface
stays calm** (no capture/recall/practice inside the reader; standing non-goal).

**Today is a finite, clearable daily board** (see "The arranger"), not an endless feed: a small, energy-aware
set you can actually finish. When it is cleared, a calm **"done for today"** invites you to rest and play
**freely — no streak, no guilt, no back-judge** (*rest is earned, not stolen*). On a low day the board
**shrinks**; a missed day is recovered from, never punished. Three arms, one restrained surface:

- **Capture — voice diary.** Tap and talk; each voice note → STT → an LLM **tidy pass (never a polish or
  rewrite)** → one **block under today's date**. Un-anchored, any language, edit/delete. Every entry
  **deposits into the learner history the coach reads**, so capture compounds — it is not a write-only journal.
- **Coach — recall proposals.** Today's **due** items (the built **SM-2** scheduler + recall store) surfaced as
  a **gentle, capped, snoozeable proposal** — *proposals, not an obligation*; a backlog never piles into a
  wall. Completing an item feeds its grade back to SM-2. **FSRS is a future swap behind the same grade-driven
  scheduler seam** — SM-2 is what ships.
- **Practice — the reading nudge.** The reading→practice nudge (a recent capture → "practise it") renders as a
  Today card; its restraint model lives under "Language practice & recall → Settled vs open".

**Tidy, not polish (the diary's invariant).** Tidy = drop fillers/false starts/repeats and lightly reorder for
readability while **preserving the speaker's wording, meaning, and voice** — never upgrade vocabulary, "fix"
phrasing to native, or translate. Polishing would erase the raw production signal the coach needs.

**Why a home, not scattered surfaces.** A proactive assistant needs one place that reaches you; without it the
engine only speaks when you walk into Practice and recall has no surface at all. The Today home **supersedes**
the earlier "quiet Library-landing pointer" — that pointer becomes a Today card. Each arm stays capped and
calm: one restrained front door, never a metrics dashboard, streaks, or gamification.

## Future direction protected by v0

- **More feeders (the growth frontier).** The moat compounds with what it is fed, and v0's feed side is thin —
  reading-notes, the reading→chunk harvest, speech-practice deposits, the voice diary. Future **capture
  sources** thicken the model behind the same scope test: e.g. a fast **"I couldn't say X" real-life jot** (the
  strongest next feeder — already a fog-of-war seed) and its mirror **"I used X for real"** (an internalization / growth signal), a **web/article clipper** for reading done outside the
  app, and **importing prior highlights/notes** to bootstrap. Each must *feed the model* (capture), never
  merely store content.
- The Entry/link + Block model supports future rich connections between materials, notes, concepts,
  and review items (block references, backlinks, transclusion) — none built in v0.
- **Internal references — one work-level link graph (settled; the v0 build hardens it).**
  Footnote/endnote markers, "see Figure 5-2", and chapter cross-refs are the **same primitive**: an
  inline **reference** to another point in the *same work*, carrying a **target** (the source
  `id`/href) and a **role** (note → superscript + back-link; cross-ref → inline link). They are **not**
  per-kind nodes re-implemented per renderer. The **keystone — historically missing, and the cause of
  the repeated regressions — is a work anchor index** built at ingest: `(source file, anchor) →
  (reading unit, block)` for the *whole* work. Resolution must be **work-scoped, not current-unit
  DOM-scoped**: a reference resolves **across chapters**, so endnotes-at-the-end and chapter cross-refs
  work, not only same-chapter anchors. A **single resolver** turns any target into a cross-unit
  **jump** (scroll + brief highlight), reusing the block-jump; footnotes add a back-link. The reader
  renders **one document model** (the PM/Tiptap doc — mdast is import/export only), so reference
  handling lives in **one place** and cannot drift between paths — the structural fix for the whack-a-
  mole. **External / cross-work / web links stay inert** (text only). This is just the intra-work case
  of the connection spine: an anchor pointing at a block.
- **PDF / scanned ingestion** via an isolated Python document-AI worker (e.g. Docling + PaddleOCR),
  with admin review of extracted content. Permissive licenses only; AGPL/GPL tools avoided.
- Semantic search (`pgvector` embeddings).
- A block-based editor (future) and LLM-assisted note drafting remain future, not v0. Language
  practice & recall is **now an active module** — see "Language practice & recall" above.
- **Editing & the document model — committed** (see "Architecture: the document-model bedrock"
  above). whetstone is a personal learning environment where the same person reads *and writes*, so a
  Notion-like block editor is a near-term direction. The content bedrock is the **Tiptap/ProseMirror
  document model** (mdast retired to import/export); the editor is the same model made editable. Build
  in slices: schema/node-specs → fidelity ingestion (fail-loud + log) → static-renderer reader →
  annotation decorations → editor.
  - The editor's **first payoff is writing**: authoring an **owned Work** — the same block/document model as
    an ingested one, but **authored** (canonical, not regenerated) and **owned** (a Work gains an `author`) —
    composed in the Tiptap editor, read back in the same reader, and **feeding the learner model** (production
    is capture). This adds a **third content category** beside *ingested* (shared, no owner) and *personal*
    (notes, owned/private): **owned content that can later be shared**; and the **rich editor becomes a shared
    capability** across writing, note bodies, and comments. **Sharing + comments are a later, separate social
    layer** — comments are already modeled (decorations + `user_id`), but *shared* reading/commenting needs the
    deferred **multi-user** step, so **authoring lands single-user first** (it crosses no new non-goal). All of
    this sits **after the bedrock pivot** (the editor is its final slice).

## v0 non-goals

- No block-editor UI (v0 edits content by re-ingestion; in-place block editing is future).
- No spaced repetition, memorization scheduling, or AI grading **in the reader**; these now live in the
  active language module (above), not in reading/annotation.
- No LLM note drafting.
- No voice or audio features **in the reader**; spoken practice (Whisper STT in / browser TTS out) lives
  in the active language module, while the reader itself stays text-only.
- No daily routine; no complicated settings.
- No PDF/scanned ingestion in v0 (it is the next stage, not a permanent exclusion).
- No remote (`http`) images, SVG, or manual/Markdown image upload in v0: figure support is **EPUB-only**,
  served from bytes extracted at ingestion. The figure **image** is display-only and not annotatable (you can
  enlarge it in a lightbox to view, but not pan, pinch-zoom, or step through a gallery — those are deferred);
  its **caption** stays selectable and annotatable like any text. These are deferred, not permanent exclusions.
- No authentication or login UI in v0: a single default user (one active person; "admin" and "reader" are
  one person in different modes). The data model still carries a **user dimension for personal data** (see
  Identity & ownership) so multi-user is a clean future migration, not a retrofit. No sign-in, sessions, or
  multi-user behavior is built yet.
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
