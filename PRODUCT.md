# Whetstone product brief

## Product promise

Whetstone is a **private, deterministic personal learning assistant** for sustained reading,
recitation, memory, diary, and writing practice.

> **You choose; Whetstone remembers, schedules, presents, and records.**

The product does not decide what the learner should care about. The learner deliberately adopts a
Work, creates a Memory item, starts a routine, or records a diary entry. Whetstone then makes that
intent durable: it keeps the source, restores context, schedules reviews, resumes progress, and
records what happened.

The current priority is not broader intelligence. It is a daily loop trustworthy enough to use for
years:

1. Choose meaningful material or a practice.
2. Do one clear next action.
3. Record the result without losing the source or raw input.
4. Return when the deterministic schedule or routine says it is time.
5. See a truthful completion state and leave without guilt.

## Product contract

These invariants outrank individual features:

1. **Complete with AI off.** With no model, API key, or model server, the learner can use Today,
   Library, Reader, Notes, Memory, Recitation, Diary, Writing, Timeline, and Search. No critical path
   waits for generated content or a model decision.
2. **Explicit intent before automation.** Whetstone may schedule something the learner enrolled, but
   it never invents a goal, silently creates practice, changes a routine phase, or grades recall.
3. **Deterministic obligations; optional invitations.** Due work comes from FSRS or an explicit
   routine rule. Continue-reading, continue-writing, lookup, and new material are invitations and do
   not block completion.
4. **Save first.** User-authored content and raw capture are persisted before optional processing.
   Model, network, and worker failures must never erase or delay the base artifact.
5. **One source of truth.** Recitation references canonical Work text; notes and Memory retain
   provenance; derived displays never become a second authoritative copy.
6. **Self-assessment is final.** The learner supplies FSRS ratings. Reveal, speech recognition, and
   model output never become an implicit grade.
7. **Small, finishable days.** Today is bounded, clearable, and calm. No streak loss, shame,
   artificially growing backlog, or engagement feed.
8. **Private by default.** Personal data stays on the learner's server and is reachable through a
   private network until authentication and access control exist.

## v0 scope

The usable personal-learning cycle contains:

- **Library and ingestion:** create or upload Works (`.epub`, `.pdf`, `.md`) and retain the source for
  provenance.
- **Reader and Notes:** read one unit at a time; select source text; look it up; save, revisit, edit,
  and delete source-linked notes.
- **Memory:** deliberately create durable notes and independently scheduled prompts; review due
  prompts with FSRS and a learner-supplied rating.
- **Recitation:** adopt a Work, familiarize, divide it into passages, learn with progressive fading,
  chain passages, and maintain the whole Work with recitation-specific FSRS.
- **Diary:** type or speak; persist raw input first; optionally transcribe and tidy; edit and revisit
  the durable entry.
- **Writing:** create an owned Work, autosave it in the shared rich editor, and read it through the
  same Reader.
- **Today:** show deterministic due work and explicit routine state, then a truthful completion.
- **Timeline and Search:** recover personal artifacts chronologically and source content by text.

The currently shipped Practice, Progress Map, generated-case, and reading-nudge surfaces are legacy
experiments, not part of this contract. They are retired in small vertical slices; their presence in
the current build must not be interpreted as product direction.

## Information architecture

Primary navigation has **four** destinations:

1. **Today** — due work, active routines, and capture.
2. **Library** — source and authored Works.
3. **Memory** — durable notes, prompts, and review history.
4. **Search** — block-level retrieval across the library.

The Reader is an immersive destination opened from context. Recitation, Diary/Timeline, Writing,
Notes, and settings are secondary destinations reached from the primary surface that owns the task.
There is no primary Practice or Progress Map destination.

Desktop/tablet uses a left sidebar. Mobile uses one non-wrapping bottom bar with four targets. Every
interactive target is at least 44px in both dimensions.

## v0 assistant home (Today)

Today is a **routine board**, not a dashboard, recommendation feed, or place where every feature asks
for attention. It has three restrained groups:

1. **Due**
   - Recitation: aggregate due count/status and one **Start** or **Continue** action into the dedicated
     session.
   - Memory: aggregate due count and one action into due review.
2. **Continue**
   - An active familiarization routine that has not recorded today's session.
   - The most recently read Work.
   - The most recently edited unfinished Work.
   - These rows are explicit invitations unless a routine contract says otherwise.
3. **Capture**
   - One compact typed/voice diary entry point.

Today renders **one summary row per capability**, not one large card per item and not an overdue wall.
Each row has a plain-language status, the minimum useful context, and one primary action. Detail and
item-by-item work live in the destination session.

**Completion rules:**

- "Done for today" appears only after all currently due Memory and Recitation work, plus any active
  daily familiarization action, are complete.
- Optional new passages, reading, writing, lookup, and diary invitations do not block completion.
- A paused routine creates no Today row and no obligation.
- A missed day creates no penalty or catch-up counter. FSRS items simply remain due.
- The completion state reports the next known due time when one exists.

Every Today arm loads independently. A failure stays inside its row with a retry; it never blanks the
page or produces a false "done" state. Today performs no proposal, nudge, case-authoring, Map, or coach
request.

## Routine model

A routine is an **explicitly enrolled practice with its own truthful state**, not a generic habit
tracker.

- Routines are `active` or `paused`. Pausing preserves content, schedule, and history but removes the
  routine from Today and from due selection. Resuming does not reset anything.
- Phase changes and daily completion are explicit events. The app does not infer completion from time
  spent, scrolling, speech, or model output.
- A "day" uses the learner's local calendar date, not a rolling 24-hour window.
- Recitation is the reference routine. Shared routine infrastructure is extracted only after reading,
  writing, or diary proves that it needs the same behavior; v0 does not begin with a speculative habit
  framework or recurrence-rule builder.

## Recitation routines

Recitation is a first-class daily practice for classical Chinese prose and poetry, English articles,
and any other Work worth retaining verbatim.

### Adoption and phases

- **Adopt, do not copy.** `Practise recitation` creates one owned `recitation_plan` Entry per learner
  and source Work. The Work remains canonical.
- **Status:** every plan is active by default and can be paused/resumed.
- **Learner-controlled phases:**
  - `familiarizing` — read for wording, sound, rhythm, and structure; no FSRS cards.
  - `learning` — learn learner-defined passages with progressive support and FSRS.
  - `maintenance` — recite the whole Work on its own FSRS schedule, with targeted passage repair.
- The learner chooses the initial phase. A new Work may start in familiarizing; a Work already known
  by heart may start directly in maintenance.
- Whetstone never infers readiness or auto-advances phase.

An active familiarizing plan is a daily routine. Opening it resumes the Reader; explicitly ending the
session records that local day as complete. `last_session_at` and `session_count` remain lightweight
plan state, not Timeline Entries and not FSRS input.

### Passage boundaries and lifecycle

A passage is a contiguous, addressable range over canonical Work blocks.

- Initial boundaries are seeded from non-empty top-level text blocks in source order.
- The learner may split or merge adjacent passages. This changes boundaries only; it never edits or
  copies the Work.
- A split or merge resets only the affected practice card(s), because the retrieval target changed.
- Source edits re-anchor safely or mark a passage `needs_repair`; stale text is never practised.
- Passage reviews and schedule changes remain plan history, not Timeline Entries.

Passages have two practice states:

- **Queued:** segmented and visible, but not introduced. It has no due obligation and is excluded from
  due counts and sessions. Its FSRS card fields are absent until activation; queued state cannot become
  due through a forgotten query predicate.
- **Active:** explicitly introduced or activated by a targeted maintenance lapse. It owns an FSRS card
  and enters due selection.

Existing reviewed passages migrate as active. New segmentation does not create a wall of immediately
due cards.

### Due-first learning and controlled new material

The learning loop is intentionally conservative:

1. Review active passages that are due, earliest due first.
2. Finish an already-started chain.
3. Review a due whole-Work card.
4. When due work is clear, optionally introduce the next queued passage in source order.

New material is never mixed invisibly into the due count. **At most one new passage per active plan per
local day** is offered in v0, and the learner must choose **Learn next passage**. Declining it still
counts as caught up. There is no setting for unlimited new passages in v0.

Each active passage and each whole-Work card uses maintained `ts-fsrs` (FSRS v6) with requested
retention **0.95**. Ordinary Memory prompts retain their separate v0 target of **0.90**. Whetstone
passes these policies to the library; it does not implement its own scheduling formula.

### Progressive support and review

The learner chooses and stores one support level per passage:

- **Full** — exact passage.
- **Reduced** — first half of each clause.
- **First characters/words** — the first character for CJK clauses or first word otherwise.
- **Hidden** — only a restrained opening or preceding-line cue.

Fading is a render-time projection. Hidden text is not exposed visually or to assistive technology,
and Reveal always shows the exact source.

After attempting aloud, the learner reveals and rates:

- **Couldn't continue** → Again
- **Needed cues** → Hard
- **Complete, with effort** → Good
- **Clean and natural** → Easy

Only the rating updates FSRS. Revealing, changing support, listening, or leaving writes no review.
There is no speech-to-text requirement, exactness score, or model grade.

### Chaining and whole-Work maintenance

- A passage is owned after at least two Good/Easy reviews and current retrievability at or above the
  recitation target (0.95). Ownership is derived, not stored.
- The owned prefix is the longest contiguous owned range from passage 0. Chains cannot skip.
- A chain contains at least two passages and rehearses their transitions. A clean run rates nothing;
  if recall broke, only the learner-identified passage receives Again.
- A Work learned inside Whetstone offers whole-Work maintenance when every passage is owned.
- A Work adopted directly in `maintenance` does **not** relearn every passage first. After its passage
  boundaries are confirmed, a whole-Work card is due immediately. Its queued passages serve as
  break-point targets; an identified break activates and rates only that passage.
- The whole-Work card has an independent 0.95 FSRS schedule. A whole-Work lapse does not reset every
  passage.

### Recitation hub and session

The secondary **Recitation** destination lists active and paused plans with title, phase, due status,
owned/total passage progress, and one next action. It owns pause/resume, phase changes, boundary
editing, and plan history. Library remains the adoption point.

Today and the hub open the same due-first session:

- one prompt at a time;
- active plans only;
- due passage → active chain → due whole Work → optional new passage;
- a visible **Stop for now** after every completed item;
- no automatic introduction of new material;
- completion reports **Due complete**, the next due time, and an optional next-passage action when
  allowed.

This closes the cycle: adopt → familiarize → divide → introduce → recall/fade → self-rate → FSRS
reschedule → chain → whole-Work maintenance → targeted repair.

## Memory

Memory is the deterministic retention system for ideas, vocabulary, expressions, and other material
the learner deliberately chooses.

- A `memory_note` is the durable, owned understanding target with a rich document body and provenance.
- A `memory_prompt` is a child retrieval direction with a cue, an answer, lifecycle state, and its own
  FSRS card when scheduled. It is not a second Timeline item.
- Creating Memory is always deliberate. Reader selections and other sources may prefill context, but
  do not silently enroll a card.
- Each scheduled prompt reveals a real back (`answer`, `gloss`, or source context) and receives one
  learner rating: Again, Hard, Good, or Easy.
- Due review is earliest-first, bounded, pausable, and requested retention 0.90.
- Snoozing changes availability explicitly; it is not a model decision.
- FSRS history and provenance remain auditable.

Reader-to-Memory capture should preserve the exact selection, Work, block anchor, and source context,
then let the learner write or confirm the durable note and prompts. A saved Reader note and a Memory
note are related but distinct choices; one never silently creates the other.

## Library, ingestion, and Reader

### v0 content ingestion

Library has one **Upload** action for `.epub`, `.pdf`, and `.md`, plus **Add work** and **New
document**:

- EPUB reads OPF metadata and authored navigation, then creates a Work and ordered ReadingUnits.
- Markdown uses confirmed title, author, and language and enters through the same block pipeline.
- PDF confirms metadata, then uses the optional isolated Docling path; scanned PDFs receive an OCR
  pre-pass. Missing tooling produces a specific setup remedy, never a corrupt Work.
- The original uploaded file and sha256 are retained for provenance.
- Ingestion is transactional and fail-loud: unknown source structures are preserved conservatively and
  emit evidence rather than disappearing silently.

### v0 reader

The Reader is reading-unit scoped and TOC driven:

- Render one ReadingUnit at a time; scroll within it and use Previous/Next between units.
- Use the authored hierarchical TOC where present; normalize structural Part → Chapter nesting.
- Remember server-side reading position (unit + best-effort block anchor) and preferences.
- Keep one stable-width, single-column reading surface; text size reflows within it.
- Desktop tools live in a persistent bottom-right rail; mobile chrome recedes and returns from a
  center tap. The TOC is a drawer at every width.
- Same-Work references resolve through a Work-scoped anchor index and may cross ReadingUnits.
  Unresolvable, external, and cross-Work references never execute unsafe navigation.
- Figures render with captions and open in a dismissible viewer that fits, enlarges, zooms, and pans.
- CJK normalization removes only scanner-like ASCII spaces between CJK characters; code and
  Latin/digit boundaries remain verbatim.

Every rendered addressable block carries its stable block id. Reader text and stored plaintext remain
byte-aligned so note offsets are trustworthy. Links use a dedicated blue channel without underline;
underline and the gutter indicator are reserved for personal note marks.

Reader readability is book-like: language-aware serif body, clear headings, lists with markers,
cohesive code blocks, readable tables, blockquotes, footnotes, and explicit empty/loading/error
states. Target body size is about 18px, line height at least 1.5, and Latin measure about 66ch.

### Notes

- A selection within one block can create a source-linked note.
- The anchor stores block id, character offsets, exact quote, and surrounding context.
- The editor opens as a side panel on wide screens and a bottom sheet on narrow screens without
  covering the selected text.
- Saved text remains visibly underlined but is not itself an undersized button. Every annotated block
  exposes an always-visible **44×44 edge affordance** with a quiet template-colored glyph; one note
  opens directly, while multiple notes open a compact anchored-text chooser. The affordance sits in
  the page margin/edge and does not alter the text's line box or cover prose.
- Notes can be listed by Work, edited, and deleted.
- Keyboard focus and touch target the edge affordance. The underline remains semantic annotation
  styling, so accessibility is not achieved by inflating inline text to a 44px line height.

Seeded note templates:

1. **Vocabulary:** meaning in context; my explanation/translation; memory hook; example I might use.
2. **Expression / phrase:** what it is doing; why useful; my imitation sentence.
3. **Thought / question:** what I noticed; why it matters; question or connection.

Preselection is deterministic: one word → Vocabulary; 2–6 words → Expression; more than six →
Thought/question. The learner may change it before saving.

### v0 vocabulary lookup

Lookup is view-only and never creates a note:

- English always has bundled WordNet as the offline baseline. Free Dictionary API data is optional
  online enrichment for pronunciation/examples/etymology; failure or offline use leaves WordNet
  lookup complete.
- Chinese uses CC-CEDICT.
- `Intl.Segmenter` interprets CJK selections before lookup.
- External dictionary links are always available as a not-found exit.
- Optional **AI explanation in context** is limited to dictionary gaps such as classical Chinese,
  idioms, allusions, and proper nouns. It is labeled, off by default, and failure leaves the
  deterministic dictionary result intact.

## Diary, Timeline, and Writing

### Diary

Typed and voice capture create the same owned `diary_entry`:

- Typed text is persisted immediately.
- Voice persists raw audio and a queued entry before transcription.
- The worker transcribes, optionally tidies, and produces the editable rich body.
- Raw input, verbatim transcript, processing state, and retry state remain available.
- A failed model tidy falls back to the transcript. A failed transcription remains retryable and
  never masquerades as success.
- Diary capture journals only. It creates no proposal, Memory item, case, or next action.

### Tidy, not polish

Tidy may remove fillers, false starts, and repeats and lightly reorder for readability. It must
preserve wording, meaning, negation, language, and voice. It must not upgrade vocabulary, translate,
or rewrite into native phrasing. A deterministic faithfulness guard rejects substitutions; raw text
is the safe fallback.

### Timeline

Timeline is a logical chronological view over owned Entries through `personal_entries`; it is not a
second store. Diary is a filter over that view. Per-review events and per-session routine counters are
history, not Timeline Entries.

### Writing

An authored Work is owned, canonical content in the same ProseMirror/Tiptap document model:

- Create it from Library.
- Edit it in the shared rich editor with debounced, latest-write-safe autosave and a pending-save
  navigation guard.
- Resume the most recently edited unfinished Work from Today.
- Read it through the same Reader.

Writing is a production tool, not an AI drafting surface. Automatic drafting and rewriting are out of
scope.

## v0 search

Search performs a case-insensitive literal substring match over the same block plaintext the Reader
renders, caps results at 50, and returns Work/author context plus an exact block deep link. It searches
the ProseMirror substrate where present and the legacy mdast substrate only for units without
ProseMirror blocks, so duplicates cannot appear.

Ranked PostgreSQL FTS, CJK segmentation indexes, and semantic search are later improvements, not
claims about current behavior.

## v0 design language (UX)

The feel is **calm, focused, and scholarly**:

- Warm paper reading surface, quiet shell, ink-indigo interaction accent.
- Source Serif/CJK Song stacks for reading; Inter for UI.
- Day and Night are token variants over the same components.
- Annotation channels remain distinct: vocabulary amber, expression teal, thought violet, Memory
  rose, and source links blue.
- Motion is purposeful in navigation and annotation, restrained in reading, and disabled by reduced
  motion.
- Layout is safe-area and `dvh` aware. Touch, mouse, pen, and keyboard all work.
- AA+ contrast, visible focus, 44px targets, and explicit empty/loading/error states are required.
- No metrics-dashboard chrome, streak theater, decorative gradients, or card wall on Today.

## v0 content model

`Entry` is the durable identity shared by Works, ReadingUnits, blocks, TOC entries, notes, diary
entries, recitation plans/passages, and Memory notes/prompts.

- Hierarchy: `Author → Work → ReadingUnit → Block`.
- Work types: `book`, `essay`, `blog_post`, `classical_text`.
- Languages: `zh-CN`, `zh-TW`, `en`.
- Blocks are atomic and addressable: paragraph, heading, list, blockquote, code, table, figure, and
  other schema nodes.
- Typed links include `contains`, `annotates`, `references`, `related_to`, and `derived_from`.
- Stable block ids survive light edits/re-ingestion where matching is safe; removed blocks are
  retained or represented so anchors fail visibly rather than drifting.
- An ingested Work is shared library content. An authored Work is owned canonical content.
- Recitation passages are Entries owned transitively through their plan and do not get their own
  `personal_entries` row.
- Memory prompts are Entries owned transitively through their Memory note and do not duplicate the
  note on Timeline.

## Identity & ownership (v0)

v0 has one `DEFAULT_USER_ID` behind a current-user provider and no login:

- Shared library Works/units/blocks have no owner.
- Notes, diary entries, authored Works, Memory notes, recitation plans, reading positions, and
  preferences are user-scoped.
- Owned Entries carry `user_id`, `occurred_at`, `created_at`, and `updated_at` in the shared
  `personal_entries` facet instead of duplicating them in each feature.
- Every personal read and write is owner-scoped even in single-user mode.
- Multi-user migration is additive: replace the provider, add real users and authentication, and
  retain existing ownership keys.

Because there is no authentication, single-user mode is a deployment constraint, not permission to
expose the app publicly.

## Architecture: the document-model bedrock (committed)

- Web: React + Vite PWA/web core.
- Server: Fastify + TypeScript.
- Persistence: PostgreSQL semantics through Drizzle; current personal deployment uses PGlite.
- Boundaries: Zod contracts; pure domain rules; Vitest; Playwright smoke.
- Rich content: ProseMirror via Tiptap, stored as decomposed block rows carrying node JSON and
  separator-free plaintext.

The ProseMirror document is the canonical model for new ingestion and authored content. The current
Reader/Search still contain a legacy mdast fallback for units not yet represented by `doc_blocks`.
That fallback is **migration debt**: preserve it until old content is safely migrated, but do not add
new feature behavior to it or claim it has already disappeared.

Personal overlays—notes, comments, Memory provenance—stay outside shared content and render as
decorations or linked Entries. Intrinsic source links may be ProseMirror marks; personal annotations
must not mutate shared Work content.

## Data safety and deployment

Daily trust requires recoverability, not just persistence:

- `DATABASE_DIR`, source files, extracted images, and any raw capture assets are durable data roots,
  outside build/runner workspaces.
- A supported backup must produce one versioned artifact from a consistent snapshot, include every
  durable root, verify its manifest/checksums, and fail with an exact remedy.
- Restore must refuse to overwrite a live destination accidentally, restore into an empty target, run
  migrations, and pass an automated round-trip test plus a documented manual drill.
- Deploy must never replace or initialize over an existing data directory silently.

Until authentication/access control exists, the supported remote path is **Tailscale Serve on the
learner's private tailnet**. Cloudflare public hostnames, Tailscale Funnel, and quick public tunnels
are unsupported for real data. A public sharing path requires a separately designed authenticated
read boundary; obscurity of the URL is not access control.

## AI boundary

Optional model-backed utilities may remain only when the deterministic artifact exists first:

- diary tidy after raw capture/transcription;
- context-grounded Reader explanation after dictionary lookup;
- future transcription quality improvements.

Each is labeled, independently disableable, timeout-bounded, and fail-soft to the deterministic
result. Generic model plumbing may be shared; product behavior must not depend on a "coach" object.

Deferred intelligence includes:

- live coach/Practice conversations and LLM grading;
- AI-authored cases or prompts;
- Progress Map/fog-of-war personalization;
- reading-to-Practice nudges;
- unsolicited next actions, "Make Durable" proposals, and history mining;
- autonomous phase changes, routine planning, or card creation.

Future intelligence earns a product surface only after:

1. the deterministic daily loop is reliable and has sufficient real history;
2. the proposal can run in **shadow mode** without changing user state;
3. outputs are evaluated against explicit usefulness/faithfulness criteria;
4. the learner opts in and approves every durable mutation;
5. disabling the model returns to the complete base product.

## Release bar: usable personal assistant

The pivot is usable only when all are true:

- With model configuration absent, a learner can ingest/read, annotate, review Memory, complete a
  recitation session, capture/edit a diary entry, write, search, and clear Today.
- A new recitation Work can move from familiarizing through one introduced passage without a due wall.
- An already-known Work can start in maintenance and schedule whole-Work recall without relearning
  every passage.
- Pause/resume preserves every routine schedule and history.
- A session ends with an honest due-complete state and next due time.
- Backup and restore round-trip representative Works, annotations, Memory, recitation history,
  diary/writing content, source files, and images.
- Day/Night and desktop/mobile retain readable hierarchy, focus, contrast, and 44px controls.
- The primary bundle does not eagerly ship retired Practice/Map experiences.

## Delivery order

1. Establish recoverable private data.
2. Remove reading nudge, live Practice, Progress Map, and their shipped proposal paths while
   preserving optional diary/Reader utilities.
3. Repair recitation maintenance bootstrap and passage activation.
4. Add controlled new material, recitation-specific retention, pause/resume, the hub, and a complete
   due-first session.
5. Recompose Today around deterministic status and that session.
6. Complete deliberate Reader-to-Memory capture and its accessible Reader controls.
7. Use the recitation routine in real daily practice before extracting shared reading/writing/diary
   routine infrastructure.

## Deferred scope and non-goals

- No autonomous arranger, coach, generated case library, Progress Map, proposal inbox, or AI grading.
- No generic habit framework, arbitrary recurrence builder, timers, quotas, or notification system in
  the recitation-first release.
- No social reading, public profiles, shared highlights, rankings, streaks, or gamification.
- No public deployment or multi-user behavior before authentication and authorization.
- No model-drafted notes, diary rewrites, essays, or recitation assessments.
- No speech recognition or pronunciation score in recitation.
- No offline write authority; the server remains the source of truth.
- Native shells may package the web core, but platform breadth does not outrank the daily web/PWA loop.
- No speculative all-of-CS tutor or general life planner. Those directions may return only as
  separately designed, source-grounded learning tracks after the base product is proven.

## Glossary

- **Work:** an ingested or authored readable source.
- **ReadingUnit:** one ordered chapter/section/essay inside a Work.
- **Block:** the stable, addressable content unit notes, search, and passages reference.
- **Personal Entry:** an owned artifact with chronology through `personal_entries`.
- **Memory note:** the durable understanding target.
- **Memory prompt:** one independently scheduled retrieval direction under a Memory note.
- **Recitation plan:** the learner's routine linked to a canonical Work.
- **Passage:** a learner-shaped source range used for recitation practice.
- **Due:** an action whose deterministic schedule/cadence has arrived.
- **Invitation:** an optional next action that never blocks Today completion.
