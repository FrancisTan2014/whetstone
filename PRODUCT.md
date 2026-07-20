# Whetstone product brief

## Product promise

Whetstone is a **private, deterministic personal learning assistant** for sustained reading,
note review, recitation, diary, and writing practice.

> **You choose; Whetstone remembers, schedules, presents, and records.**

The product does not decide what the learner should care about. The learner deliberately adopts a
Work, adds a note to review, enrolls known material for maintenance, or records a diary entry.
Whetstone then makes that intent durable: it keeps the source, restores context, schedules reviews,
resumes progress, and records what happened.

The current priority is not broader intelligence. It is a daily loop trustworthy enough to use for
years:

1. Choose meaningful material or a practice.
2. Do one clear next action.
3. Record the result without losing the source or raw input.
4. Return when the deterministic schedule says it is time.
5. See a truthful completion state and leave without guilt.

## Product contract

These invariants outrank individual features:

1. **Complete with AI off.** With no model, API key, or model server, the learner can use Today,
   Library, Reader, Notes and Review, Recitation, Diary, Writing, and Search. No critical path waits
   for generated content or a model decision.
2. **Explicit intent before automation.** Whetstone may schedule something the learner enrolled, but
   it never invents a goal, silently creates practice, changes enrollment/card state, or grades
   recall.
3. **Deterministic obligations; optional invitations.** Due work comes from FSRS over material the
   learner explicitly enrolled. Continue-reading, continue-writing, lookup, and capture are
   invitations and do not block completion.
4. **Save first.** User-authored content and raw capture are persisted before optional processing.
   Model, network, and worker failures must never erase or delay the base artifact.
5. **One source of truth.** Recitation references canonical Work text; review prompts reference
   canonical notes; provenance and derived displays never become a second authoritative copy.
6. **Self-assessment is final.** The learner supplies FSRS ratings. Reveal, speech recognition, and
   model output never become an implicit grade.
7. **Small, finishable days.** Today is bounded, clearable, and calm. No streak loss, shame,
   artificially growing backlog, or engagement feed.
8. **Private by default.** Personal data stays on the learner's server and is reachable through a
   private network until authentication and access control exist.
9. **Material, retrieval, and scheduling are separate.** A note or canonical Work records what the
   learner cares about; a feature-owned review target defines one retrieval task against that
   material; a review card stores only scheduling policy/state and points to that target. Material
   never carries FSRS state, and pausing or removing a schedule never rewrites the material.
10. **Retrieval direction is part of the target.** Recognizing material, recalling its meaning, and
    producing it from a communicative intention are different retrieval tasks. Success in one never
    clears another target's card or certifies another capability.

## v0 scope

The usable personal-learning cycle contains:

- **Library and ingestion:** create or upload Works (`.epub`, `.pdf`, `.md`) and retain the source for
  provenance.
- **Reader and Notes:** read one unit at a time; select source text; look it up; save, revisit, edit,
  and delete rich notes with optional source anchors.
- **Notes and Review:** keep anchored and standalone notes in one surface; deliberately add a
  retrieval question to a note; review the current note body with FSRS and a learner-supplied rating.
- **Recitation:** enroll a Work the learner can already recite, reveal and self-rate whole-Work
  recall, and maintain it with recitation-specific FSRS.
- **Diary:** type or speak; persist raw input first; optionally transcribe and tidy; edit and revisit
  the durable entry in a reverse-chronological timeline.
- **Writing:** create and resume owned essays from a dedicated Writing home, autosave them in the
  shared rich editor, and read them through the same Reader.
- **Today:** show deterministic due work and optional continuations, then a truthful completion.
- **Search:** recover source content by text; Diary owns the chronological journal view.

The former Practice, Progress Map, generated-case, and reading-nudge surfaces were legacy
experiments, not part of this contract. They have been retired, so the shipped product no longer
contains a coach-led Practice experience or a deterministic fake standing in for one.

## Information architecture

Primary navigation has **six** destinations:

1. **Today** — due work, optional continuations, and capture.
2. **Library** — source and authored Works.
3. **Write** — authored essays and their editor.
4. **Recite** — enrolled Works, due maintenance, and next review dates.
5. **Notes** — anchored and standalone notes, review enrollment, and due Review.
6. **Diary** — typed/voice capture and the chronological journal.

Search is a persistent one-action shell utility, not a primary destination. Reader belongs to
Library; the authored-Work editor belongs to Write; note Review belongs to Notes; Recitation review
belongs to Recite. Library still shelves authored Works for reading, but it does not own their
creation or editing. Every secondary surface keeps its parent visibly active and provides one
explicit return path. Old Memory and Recall links redirect into Notes and its Review session. There
is no primary Practice or Progress Map destination.

Desktop/tablet uses a left sidebar. Mobile uses one non-wrapping bottom bar with six targets at
320px and above. Every navigation target is at least 44px in both dimensions.

## v0 assistant home (Today)

Today is a **routine board**, not a dashboard, recommendation feed, or place where every feature asks
for attention. It has three restrained groups:

1. **Due**
   - Recitation: aggregate every unpaused Work's due state and provide one action into direct review.
   - Notes review: aggregate due note prompts and provide one action into Notes-owned Review.
   - These remain separate rows and separate review modes; Today never creates a mixed queue.
2. **Continue**
   - The most recently read Work.
   - The most recently edited unfinished Work.
   - These rows are explicit invitations and render only when a resumable item exists. Empty
     placeholders do not appear.
3. **Capture**
   - One compact **New diary entry** control that opens the shared typed/voice capture only after
     activation, then returns to its compact state after saving.

Today renders **one summary row per capability**, not one large card per item and not an overdue wall.
Each row has a plain-language status, the minimum useful context, and one primary action. Detail and
item-by-item work live in the destination session.

**Completion rules:**

- "Done for today" appears only after all currently due note Review and Recitation work is complete.
- Reading, writing, lookup, and diary invitations do not block completion.
- Paused review or Recitation maintenance creates no obligation.
- A missed day creates no penalty or catch-up counter. FSRS items simply remain due.
- The completion state reports the next known due time when one exists.

Every Today arm loads independently. A failure stays inside its row with a retry; it never blanks the
page or produces a false "done" state. Today performs no proposal, nudge, case-authoring, Map, or coach
request.

## Routine model

v0 keeps routine state narrow:

- Recitation maintenance and note Review are `active` or `paused`. Pausing preserves material,
  schedule, and history but removes the card from Today and due selection. Resuming resets nothing.
- FSRS determines due obligations. Whetstone has no phase progression, daily familiarization
  completion, arbitrary recurrence rule, or inferred completion from time, scrolling, speech, or
  model output.
- A "day" uses the learner's local calendar date for grouping and display, not as a second scheduler.
- Shared routine infrastructure is extracted only after another concrete practice proves it needs the
  same invariant; v0 has no speculative habit framework.

## Recitation maintenance

Recitation maintains classical Chinese prose and poetry, English articles, and any other canonical
Work the learner can already recite. Acquisition may happen anywhere; Whetstone begins at durable
maintenance.

### Enrollment and ownership

- Library and Reader expose **I can recite this** for an eligible Work.
- Enrollment creates or reuses one owner-scoped `recitation_plan`, one Work-level Recitation target,
  and one active shared review card at requested retention **0.95**. The Work remains the only source
  text.
- The card is due immediately. Enrollment persists before review opens, creates no rating event, and
  is idempotent across retries. An existing plan without an active target retains its identity and
  gains this direct maintenance target.
- Pausing or removing maintenance preserves the Work, schedule history, and review events.
- The plan is only enrollment and active/paused state. There is no phase picker, familiarization,
  passage division, daily introduction, progressive fading, chaining, ownership count, or targeted
  repair in v0.
- Legacy passage/card/event history remains auditable but creates no future obligation. Retired routes
  recover to the exact Work's direct maintenance state or Library rather than opening dead curriculum
  screens.

### Due aggregation and ordering

- Today aggregates every due card from every unpaused, owner-scoped Recitation plan. A partial load
  cannot produce a false all-clear state.
- Global review opens the Work with the earliest due card. A Work-specific entry always opens that
  exact Work; recency never hides another Work's obligation.
- The session is a transient projection over canonical targets and cards. It persists no cross-Work
  queue, completion cursor, or duplicate schedule.

### Review

The learner opens a due Work, recites from memory, chooses **Reveal source**, and rates the attempt
Again, Hard, Good, or Easy.

- Before reveal, source text is neither visually nor accessibly exposed.
- Reveal uses the current canonical Work. Leaving before rating writes no event and keeps the card due.
- One rating appends one review event, reschedules only that Work-level card through maintained
  `ts-fsrs` (FSRS v6), and shows the next scheduled local time. A short-term interval due on the
  current local day is labeled **Later today** with its exact time; it is never collapsed to the
  current date with no explanation.
- If another Work is due, **Review next** is optional; nothing opens automatically. Otherwise the
  session reports **Due complete**.
- Loading, reveal, and rating failures stay on the current Work with a specific retry and never
  fabricate completion.
- There is no notification, speech grade, exactness score, timer, streak, or automatic repair task.

This closes the cycle: **I can recite this → recite → reveal source → self-rate → FSRS next time**.

## Notes and Review

Notes and Review are one user-facing system over material the learner deliberately chooses, not
competing content stores.

- A `note` is the single durable, owned note model: one canonical rich document body, timestamps, and
  optional source anchor/provenance. Reader notes, manually added words/phrases, imported answers, and
  free-form thoughts use this same model.
- A note contains no copied answer, review lifecycle, or FSRS fields.
- One user-facing card is a learner-authored retrieval contract: a rich **Question** that triggers the
  task, a grading target that says what counts as successful retrieval, a referenced note, and one
  shared review card that owns only FSRS state and history.
- The grading target has two progressively disclosed shapes, never a template choice. By default the
  current note body is the Answer. When that material is broader than the intended retrieval, the
  learner may define one concise rich **Success check**; Review reveals it first and shows the current
  note below as live Reference. A Success check is task-specific evidence, not a copied summary of the
  note, and preserved `legacy_custom` answers remain a separate historical shape.
- Notes presents **New card** as its primary action; **New note** and **Import** remain visible secondary
  actions. New card starts from **What do you want to be able to recall or do?**, then asks **What
  should bring it to mind?** A simple card needs only rich Answer and Question editors; **Define a
  specific success check** is optional. The standing guidance is **One target · clear trigger · enough
  to judge**, never a validator or quality score.
- **Try card** previews the exact Question → attempt → reveal interaction before saving. It is optional
  and writes no card, event, or schedule.
- Saving a new card atomically creates one manual note, one prompt with its chosen grading target, and
  one active shared review card at requested retention **0.90**, due immediately. A retry reuses that
  same result; a failed or repeated request never leaves a half-card or duplicate. The action states
  plainly that it adds one recurring review.
- Every saved note exposes **Cards**. Creating another card adds another learner-authored retrieval
  contract against the same live reference note. Reader selection remains visible source context but
  never silently becomes the Question or chooses a retrieval direction.
- Each retrieval contract has its own review card, schedule, and history. Recognition and production
  targets may share a reference while being learned and scheduled independently; Whetstone never
  auto-reverses them or shares one direction's performance with another.
- Imported cardless prompts keep their rich Questions and enter Review only when the learner explicitly
  adds their existing card. Legacy prompt-specific reveals remain readable and reviewable without
  silent conversion.
- Editing a Question changes only that prompt's rich cue and server-derived readable text. Editing the
  reference changes only the canonical note body. Both preserve schedule/history. Editing or switching
  a Success check asks the learner whether this is the same target (**Keep schedule**) or a changed
  target (**Restart** with an explicit reset event); Whetstone never guesses.
- Review shows one Question and keeps every grading target/reference hidden until reveal. Reveal shows
  either the current note Answer or the explicit Success check followed by Reference. **Fix card** is
  available before rating: saving a repair writes no rating event, keeps the item due, and returns to
  its Question so a defective task never becomes false memory evidence. Again, Hard, Good, or Easy then
  appends one event, reschedules only that card, and shows the next scheduled local time. A short-term
  interval due on the current local day is labeled **Later today** with its exact time.
- The learner may stop after any item. A note's Cards section owns question editing, pause/resume,
  restart, removal, due state, and auditable history. Removing review never deletes the note.
- Notes lists anchored and standalone notes together, supports search and editing, and owns paste-list
  import. Import creates standalone notes plus referencing prompts, never a second content row.
- Old `/memory` and `/recall` links redirect to Notes and Notes-owned Review without losing due state.
- Whetstone does not generate, grade, template, type, or police cards in v0. It provides a reliable
  authoring, preview, repair, and scheduling tool; understanding the material and choosing a precise
  retrieval target remain the learner's work. Keeping material as a Note without accepting a recurring
  review is valid. A card's performance is evidence for that target only, never proof that the material
  is internalized or available in unprompted speech.

Reader capture always creates and saves the note first, with exact selection and provenance. Creating
a card from it remains an explicit learner action.

## Library, ingestion, and Reader

### v0 content ingestion

Library has one **Add** menu with **Upload file** (`.epub`, `.pdf`, `.md`) and **Add work
manually**. Writing owns **New essay** and authored-Work creation. Each Library option enters its
owning source flow:

- EPUB reads OPF metadata and authored navigation, then creates a Work and ordered ReadingUnits.
- Markdown uses confirmed title, author, and language and enters through the same block pipeline.
- PDF confirms metadata, then uses the optional isolated Docling path; scanned PDFs receive an OCR
  pre-pass. Missing tooling produces a specific setup remedy, never a corrupt Work.
- Manual and Markdown Works derive their Reader structure from the source's heading levels. `#`
  headings create chapters, deeper headings create nested sections, and content management shows
  the resulting outline. This hierarchy is projected from canonical source headings, not maintained
  as a second editable TOC that can drift.
- The original uploaded file and sha256 are retained for provenance.
- Ingestion is transactional and fail-loud: unknown source structures are preserved conservatively and
  emit evidence rather than disappearing silently.

The Library is a read-first shelf:

- Every Work exposes exactly one persistent **Read** or **Continue** action.
- One Work-specific overflow contains valid setup/management actions: Recitation enrollment/open,
  Work-scoped Notes, edit/manage content, and confirmed deletion. Authored Works do not expose a
  second persistent Edit action; their overflow routes to **Edit in Writing**.
- Ongoing Recitation phase/due/progress state belongs in Recite, not on Library cards.
- Markdown import remains supported, but reconstructed **Export Markdown** is not a trustworthy
  portable copy and is not a product capability. Backup/restore remains the recovery path.

### v0 reader

The Reader is reading-unit scoped and TOC driven:

- Render one ReadingUnit at a time; scroll within it and use Previous/Next between units.
- Use the authored hierarchical TOC where present; normalize structural Part → Chapter nesting.
  Manual and Markdown Works project the same Reader tree from canonical heading levels. Content
  before the first heading is **Start** when later headings make navigation necessary; a headingless
  single-unit Work needs no TOC.
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
underline is reserved for personal note marks.

Reader readability is book-like: language-aware serif body, clear headings, lists with markers,
cohesive code blocks, readable tables, blockquotes, footnotes, and explicit empty/loading/error
states. Target body size is about 18px, line height at least 1.5, and Latin measure about 66ch.

### Notes

- A selection within one block can create a source-linked note.
- The anchor stores block id, character offsets, exact quote, and surrounding context.
- The editor opens as a comfortable wide side panel on desktop
  (`clamp(28rem, 46vw, 36rem)`, viewport-capped) and a full-width bottom sheet on narrow screens
  without covering the selected text. Its bordered **workspace** body is
  `clamp(16rem, 42dvh, 28rem)` tall on desktop and `clamp(12rem, 34dvh, 20rem)` on narrow screens;
  the Sheet scrolls when surrounding source or Review controls need more room.
- The note body uses the shared rich-text editor. There is no template selector, automatic
  classification, structured answer form, or generated Markdown copy.
- Activating underlined text by mouse, touch, or keyboard opens that exact note. A chooser appears only
  where annotations genuinely overlap; several non-overlapping notes in one paragraph never create a
  paragraph-level chooser.
- A bodyless Mark opens its own compact actions directly. Activating an existing annotation never
  starts a new selection flow.
- Notes can be listed by Work, edited, deleted, and deliberately added to review.
- Inline annotations have clear hover/focus treatment and accessible names. They use the WCAG
  inline-text target exception rather than inflating line height; the 44px Notes tool/list remains an
  alternate target. There is no permanent paragraph pencil, reserved annotation gutter, or
  block-level routing.
- Formatting, link, block, and slash-command menus render above the modal sheet and remain keyboard
  operable in Day and Night.
- The existing one-tap **Mark** remains a bodyless highlight, not a note template. It enters review only
  after the learner converts it to a note and confirms a review question.

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

- Typed capture starts in the shared rich editor. Saving persists its canonical ProseMirror document
  immediately and derives plaintext only for search/preview; there is no plain-text compose variant
  or flatten-and-rebuild round trip. Diary uses the workspace presentation, while Today's activated
  capture uses the compact presentation.
- Voice persists raw audio and a queued entry before transcription.
- The worker transcribes with automatic language detection, optionally tidies, and produces the
  editable rich body. There is no capture language switch or forced-language configuration.
- Detected language is nullable observed metadata. Detection failure never fails capture, and existing
  stored language values remain valid.
- The raw typed document or audio, verbatim voice transcript, processing state, and retry state
  remain available.
- A failed model tidy falls back to the transcript. A failed transcription never masquerades as
  success. It exposes a stable, safe failure category, says whether the recording is retryable, and
  gives the exact remedy; raw adapter/process details remain in server logs rather than leaking
  through the client contract.
- Diary capture journals only. It creates no proposal, review prompt, case, or next action.

### Tidy, not polish

Tidy may remove fillers, false starts, and repeats and lightly reorder for readability. It must
preserve wording, meaning, negation, language, and voice. It must not upgrade vocabulary, translate,
or rewrite into native phrasing. A deterministic faithfulness guard rejects substitutions; raw text
is the safe fallback.

### Timeline

Diary opens directly to a reverse-chronological timeline grouped by the learner's local day. It loads
older day pages automatically from a bounded cursor, stops at the terminal page, and offers a clear
retry after failure. The timeline renders each canonical rich body; clicking an entry opens the same
rich editor, and edits and deletions update the visible timeline. Leaving and returning during one
app session restores scroll position. There is no month calendar, date-jump mode, or separate
calendar API.

The timeline is a logical chronological view over owned Entries through `personal_entries`; it is not
a second store. Diary filters that view to journal entries. Review events are history, not Timeline
Entries.

### Writing

Writing is a primary destination with a focused home over authored Works:

- **New essay** is the one creation action; it asks for title, language, and Work type (default
  `essay`), then opens the editor.
- The home lists authored Works by most recently edited and provides one clear **Continue writing**
  action per Work. The same Works remain visible in Library for reading.
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
- Global meaning channels are restrained: indigo for interaction/selection, blue for intrinsic links,
  amber for personal annotations, and red for destructive/error states. Retired
  Vocabulary/Expression/Thought/Gem categories own no global tokens. Review enrollment never recolors
  source prose because schedule state is not annotation meaning.
- Standard pages share one frame: 16px mobile/24px desktop gutters, a 42rem focused or 64rem
  collection width, a 28px/34px semibold title, optional parent link, and at most one persistent
  primary header action. Reader keeps its immersive 66ch frame while sharing the same semantics.
- General UI iconography comes from tree-shaken Lucide icons: 20px with a 1.75 stroke (16px only in
  dense editor controls). Text glyphs such as arrows, crosses, returns, and ellipses are not controls.
  Icon-only controls retain a specific accessible name, tooltip, visible focus, and 44px target;
  ambiguous or consequential actions keep visible labels.
- Motion is purposeful in navigation and annotation, restrained in reading, and disabled by reduced
  motion.
- Layout is safe-area and `dvh` aware. Touch, mouse, pen, and keyboard all work.
- AA+ contrast, visible focus, 44px targets, and explicit empty/loading/error states are required.
- No metrics-dashboard chrome, streak theater, decorative gradients, or card wall on Today.

## v0 content model

`Entry` is the durable identity shared by Works, ReadingUnits, blocks, TOC entries, notes, diary
entries, Recitation plans, and review targets.

- Hierarchy: `Author → Work → ReadingUnit → Block`.
- Work types: `book`, `essay`, `blog_post`, `classical_text`.
- Languages: `zh-CN`, `zh-TW`, `en`.
- Blocks are atomic and addressable: paragraph, heading, list, blockquote, code, table, figure, and
  other schema nodes.
- Typed links include `contains`, `annotates`, `references`, `related_to`, and `derived_from`.
- Stable block ids survive light edits/re-ingestion where matching is safe; removed blocks are
  retained or represented so anchors fail visibly rather than drifting.
- An ingested Work is shared library content. An authored Work is owned canonical content.
- A Recitation plan is one owner-scoped enrollment referencing a canonical Work. Its Work-level review
  target owns no source copy. Legacy passage Entries may remain for audit but are not active targets.
- Review targets are Entries owned transitively through their material/plan and do not duplicate it on
  Timeline.
- Review cards are scheduling facets over review-target Entries, not Entries or content. One shared
  card shape owns FSRS state and policy for note Review and Recitation; feature tables retain only
  their retrieval question, material reference, and lifecycle semantics.
- Review events are append-only scheduler transitions. No feature duplicates card due state.

## Identity & ownership (v0)

v0 has one `DEFAULT_USER_ID` behind a current-user provider and no login:

- Shared library Works/units/blocks have no owner.
- Notes, diary entries, authored Works, Recitation plans, review cards, reading positions, and
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

Personal overlays—notes, comments, and review provenance—stay outside shared content and render as
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
- autonomous enrollment, routine planning, or card creation.

Future intelligence earns a product surface only after:

1. the deterministic daily loop is reliable and has sufficient real history;
2. the proposal can run in **shadow mode** without changing user state;
3. outputs are evaluated against explicit usefulness/faithfulness criteria;
4. the learner opts in and approves every durable mutation;
5. disabling the model returns to the complete base product.

## Release bar: usable personal assistant

The pivot is usable only when all are true:

- With model configuration absent, a learner can ingest/read, annotate, review notes, complete a
  Recitation review, create/preview/repair rich retrieval cards, type/edit a diary entry, write,
  search, and clear Today.
- A card may use its current note as the Answer or an explicit Success check with the note as Reference;
  separate directions schedule independently, and fixing an unclear card before rating records no
  false review.
- An already-known Work can enter maintenance in one action, remain due if the learner leaves before
  rating, and later resurface from its whole-Work FSRS schedule.
- Today includes every unpaused due Recitation Work and every due note prompt; neither recency nor a
  currently open Work can create a false all-clear state.
- The six primary destinations remain truthful on desktop/mobile, and Search stays one action away.
- Reader annotations open their exact note; rich-editor floating controls stay usable above the wide
  desktop note sheet.
- Diary capture requires no language choice, and Diary history is a paginated chronological timeline
  without calendar chrome.
- Pause/resume preserves every review schedule and history.
- A session ends with an honest due-complete state and next due time.
- Backup and restore round-trip representative Works, annotations, note-review and Recitation history,
  diary/writing content, source files, and images.
- Day/Night and desktop/mobile retain readable hierarchy, focus, contrast, and 44px controls except
  for the deliberate inline-text target exception.
- The primary bundle does not eagerly ship retired Practice/Map experiences.
- After the current daily-loop work lands, one `main` commit passes a maintainer-clicked manual
  end-to-end walkthrough and seven consecutive local-calendar days of normal use. A loop-breaking
  defect or runtime change restarts the window; cosmetic findings and documentation/test-only changes
  do not. Broader feature work resumes only after this gate passes.

## Delivery order

1. Establish recoverable private data.
2. Remove reading nudge, live Practice, Progress Map, and their shipped proposal paths while
   preserving optional diary/Reader utilities.
3. Replace the Recitation curriculum with direct whole-Work maintenance, truthful cross-Work due
   aggregation, and the direct reveal/rate session.
4. Restore direct annotation editing and reliable rich-editor surfaces, then consolidate Notes and
   Review and add direct rich card authoring without resetting schedules or history.
5. Remove manual speech-language configuration and reduce Diary to capture plus its paginated
   timeline.
6. Recompose navigation around Today, Library, Write, Recite, Notes, and Diary, with Search as a
   utility.
7. Manually click through the integrated product, then use that same runtime build normally for seven
   consecutive days before adding scope or extracting shared routine infrastructure.

## Deferred scope and non-goals

- No autonomous arranger, coach, generated case library, Progress Map, proposal inbox, or AI grading.
- No generic habit framework, arbitrary recurrence builder, timers, quotas, or notification system in
  the recitation-first release.
- No in-app dogfood tracker, release dashboard, telemetry, streak, or quota for the manual release
  gate.
- No in-app Recitation acquisition curriculum, phase progression, passage fading, chaining, or
  targeted repair before whole-Work maintenance is dogfooded.
- No card template chooser, generated-card bulk enrollment, quality score, or automatic diagnosis or
  repair prompt based on repeated ratings.
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
- **Block:** the stable, addressable content unit notes and search deep links reference.
- **Personal Entry:** an owned artifact with chronology through `personal_entries`.
- **Note:** one owned rich artifact, optionally anchored to source material.
- **Review target:** one feature-owned retrieval contract over durable material.
- **Review card:** scheduler policy/state for one review target; it contains no learning material.
- **Review event:** one append-only learner rating or explicit schedule reset for a review card.
- **Success check:** a concise learner-authored grading target for a retrieval task whose whole note is
  too broad to judge.
- **Note review prompt:** one learner-confirmed Question plus grading-target policy that references a
  canonical note.
- **User-facing card:** one note review prompt, its current Answer/Reference, and that prompt's
  independent review card.
- **Recitation plan:** one active/paused maintenance enrollment linked to a canonical Work.
- **Recitation target:** the whole-Work retrieval task owned by a Recitation plan.
- **Due:** an action whose deterministic schedule has arrived.
- **Invitation:** an optional next action that never blocks Today completion.
