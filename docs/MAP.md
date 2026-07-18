# Repository map

Navigational index: subsystems to their locations. **Pointers and invariants only — never
restated code behavior.** Read `PRODUCT.md` and `GUIDELINES.md`, then this map, then only the one
feature slice you need. Maintained per `GUIDELINES.md` -> "Knowledge surfaces and onboarding cost":
updated by the same PR that changes an area's shape, not on every change.

When a folder below outgrows its single entry here, give it a colocated `AGENTS.md` and shrink its
entry to a pointer.

## Packages

### `src/packages/document/` — content document model (bedrock)

The Tiptap/ProseMirror schema for whetstone content (PRODUCT "Architecture: the document-model
bedrock"). Pure and Node-runnable (the browser editing DOM specs are declarative; fidelity HTML
ingestion and read-only presentation remain in their feature slices). Public surface is `src/index.ts`.
Units: `nodes.ts` (Tiptap `Node.create` specs for doc,
text, prose blocks, nesting lists, tables, figures, definition lists, callout, footnote marker/target,
and a raw-HTML `unknown` fallback, plus shared `bold`/`italic`/inline-`code`/`link` marks; `link`
carries a validated authored `href` or a same-work cross-reference's
`kind`/`anchor`/`refFile`/`targetSourceFile`/`inert` inline on the text run; the `image` node carries an
`imageResourceId` attr (default null)
so a resolved EPUB image can be referenced by the reader; `documentExtensions` couples the node + mark
specs with the UniqueID id attribute), `schema.ts` (`documentSchema` via `getSchema`; `generateNodeId`), `document.ts`
(`parseDocument`/`serializeDocument`/`isValidDocument`/`assignNodeIds` JSON round-trip + validation,
`DocumentValidationError`). Stable node ids use Tiptap UniqueID's server-side generator. Tests
colocated. Invariant: depends on nothing outward; no UI, ingestion, or editing here.

### `src/packages/domain/` — pure logic

Entry/link/block/template/note-anchor rules with no React, Fastify, DB, fs, or env. Public surface is
`src/index.ts`. Current units: `entry.ts`, `links.ts`, `block.ts`, `markdownBlocks.ts` (decompose
Markdown into ordered, stable-id blocks; exports the shared `blockFromMdastNode` mapper, which
strips image nodes — v0 is text blocks only — and skips a block left empty by that removal),
`blockDiff.ts` (content-similarity diff matching new blocks to existing ones — Dice-bigram alignment —
to preserve stable ids on re-ingestion), `htmlBlocks.ts` (decompose one EPUB chapter's XHTML into a
reading unit of blocks via `rehype-parse` + `rehype-remark`; detects structural `<figure>`/top-level
`<img>` at the hast stage and emits figure blocks carrying the transient image src + alt + caption,
consuming `<figcaption>` so it is never a heading or the unit title), `epubMetadata.ts` (normalize OPF
title/author/language), `blockMarkdown.ts` (serialize a block's mdast back to Markdown for safe
rendering; `blocksToMarkdown` reconstructs a whole work for re-ingestion diffing), `author.ts`, `work.ts`,
`noteTemplate.ts` (v0 note templates +
size-based preselection), `noteAnswers.ts` (answer validation + note-body Markdown), `noteAnchor.ts`
(anchors a note to a block id with an optional sub-block offset range), `productIdentity.ts`,
`diaryTimeline.ts` (#246 voice-diary pure date logic — `isDayKey` day-key validation; day-grouping
lives in `timeline.ts`),
`localDay.ts` (#606 the learner's local calendar-day boundary: the single pure projection
`localDayKey(instant, timeZone)` + `localDayBoundary(now, timeZone) → {dateKey, utcStart, utcEnd}` and
`isTimeZone`, exact over `Intl` — every day-grouping/per-day-cap consumer derives its day from here so
Today/Recitation/Diary can never disagree; DST-length days are why the boundary returns two instants),
`timeline.ts` (#571 the logical Timeline: the `diary`/`note`/`work`/`recitation` discriminated-kind
vocabulary, each kind
mapped to a real Entry type — there is no `timeline_entry`; the deterministic order `occurredAt` DESC with a
stable `entryId` ASC tie-break; and day-grouping/`timelineDays`/`groupTimelineEntriesByDay` (each taking the
learner's `timeZone` via `localDay.ts`) so the Timeline
is a derived view, never a store), `recitation.ts` (#577/#643 the recitation-plan phase vocabulary
`familiarizing`/`learning`/`maintenance` + `isRecitationPhase`, retained only so legacy rows stay readable
— direct enrolment always lands `maintenance`; plus the #643 `recitationRatingChoices` worst→best labels
mapping one-to-one onto the shared FSRS ratings for the whole-Work review), `recitationSession.ts`
(#633/#643 the pure global recitation aggregate: `RecitationPlanObligation`/`RecitationAggregateDue`,
`selectRecitationWork` + `compareRecitationObligations` folding every unpaused plan's Work-level
maintenance card into one truthful due summary and the single Work to work now — no persisted queue,
passage, chain, or introduction state) and
`diaryTidy.ts` (the "tidy not polish" prompt builder + the invariant instruction text). Tests
are colocated `*.test.ts`. Invariant: depends on nothing outward.

### `src/packages/contracts/` — shared API schemas/DTOs

Zod request/response contracts shared by client and server. Public surface is `src/index.ts`.
Current contracts: `entryContracts.ts`, `libraryContracts.ts`, `contentContracts.ts`,
`noteContracts.ts`, `lookupContracts.ts` (the lookup route query validator + the shared
`NormalizedEntry` shape and `LookupResponse` DTO rendered by the reader), `searchContracts.ts`
(the `/api/search` query validator + the block-level `SearchResultsDto`), `diaryContracts.ts` (#571
diary create/update + logical-Timeline DTOs: `DiaryEntryDto` carries the rich `bodyDoc`
(ProseMirror/Tiptap document, validated against `@whetstone/document`) + `bodyText`, `occurredAt`/
`createdAt`/`updatedAt`, `language`, `inputMode`, nullable `processingStatus`/`failureReason`; the
Timeline is a `kind`-discriminated union DTO (`diary` | `note` | `work` | `recitation`) grouped into day/page DTOs, and Diary is
the `kind === "diary"` filter — update edits the rich `bodyDoc`),
`recitationContracts.ts` (#577/#643 direct Work-level maintenance: `recitationPhaseDtoSchema` (legacy,
readable-only), `enrollRecitationRequestSchema` (just a Work entry id — no phase choice),
`RecitationPlanDto`/list (the durable plan identity: Work + phase + session bookkeeping),
`recitationReviewDtoSchema` (the whole-Work review — plan/Work identity, the canonical source read live,
the card's `dueAt` + FSRS `state`) + `recitationReviewResponseSchema` (review-or-null),
`recordRecitationReviewRequestSchema` (one of `again`/`hard`/`good`/`easy`) + non-null response,
`recitationOverviewDtoSchema` (#638 the Recite-home DTO: `dueCount` + `works[]`, each carrying Work identity,
`isDue`, nullable `nextReviewAt`/`state`, `paused`) + `parseRecitationOverviewDto`, and
their `parse*` boundary helpers; the Timeline union keeps a `recitation` member carrying the Work title +
phase),
`voiceCaptureContracts.ts` (#565 — async Tap-and-Talk: the `processing_status` enum
`queued/transcribing/tidying/ready/failed`, the submit query validator, and the accepted/status DTOs),
`hostRuntimeContracts.ts` (#445 — the host↔web-core runtime contract: `HostRuntimeConfig`
(`platform` + `apiBaseUrl`) schema, `resolveHostRuntimeConfig` (validates the injected config, fails
loud, defaults browser web to `/api`), and the pure `resolveApiUrl` base+path joiner), `health.ts`. Tests colocated.
Invariant: types resolve through built `dist` — run `pnpm build` (or `tsc -b`) before VS Code/tsc
can navigate them from another package.

## Apps

### `src/apps/server/` — Fastify API

- Composition/entry: `src/index.ts` (in-memory PGlite unless `DATABASE_DIR` is set); `dev-server.mjs`
  is the local dev entrypoint, run via `tsx watch` (`pnpm --filter @whetstone/server dev`) so the
  server runs from **source with reload** — a newly landed route is live without a manual `build` (no
  stale `dist/` 404s) — and it defaults `DATABASE_DIR` to a git-ignored `.data/db` so content
  survives a restart. `start` (`node dist/index.js`) is the production path. Server assembly in
  `src/http/createServer.ts`.
- Single-origin serving: when `WEB_DIR` is set, `createServer`'s `web` option registers
  `src/http/staticWeb.ts` (`@fastify/static`) so the built web client is served at `/` alongside
  `/api/*` from one port — the deploy path (#184). Unset in dev/tests, where Vite serves the client.
- Identity seam: `src/identity/currentUser.ts` — the single `DEFAULT_USER_ID` constant + the
  `CurrentUserProvider` (`getCurrentUserId()`). `createServer` decorates the instance with it
  (`request.server.currentUser`), defaulting to the v0 provider; tests/future auth inject their own.
  No users table, login, session, or content owner yet (PRODUCT.md "Identity & ownership (v0)").
  `notes` is a user-owned facet: note routes resolve the current user via
  `request.server.currentUser` and source ownership + chronology from the shared `personal_entries` facet
  (a `note` Entry gets a `personal_entries` row on create — `user_id`/`occurred_at`/`created_at`/`updated_at`;
  reads filter by `personal_entries.user_id`) rather than a `user_id`/`created_at` on `notes` itself
  (`noteCommands.ts`/`noteQueries.ts`); `reading_positions` is user-owned the same way; Memory notes are
  - the SAME `notes` facet (#620 — one note type; a Memory note is an unanchored `kind='note'` row),
    user-owned via `personal_entries`; shared content tables stay unowned.
- Review substrate (shared FSRS cards) (#617): `src/apps/server/src/features/review/` is the single owner
  of spaced-repetition scheduler mechanics, extracted out of Memory so Recitation (and future recall
  surfaces) share it. `review_cards` holds one card per learnable target (keyed by the target's `entries.id`
  via `target_entry_id`, owner-scoped by `user_id`) with the FSRS columns; `review_events` is the
  append-only history (FK → `entries.id`, not the card, so events survive a card being cleared/restarted;
  a `type` check discriminates `rating`/`reset`). `reviewCardCommands.ts` is the write/transition boundary
  (`seedReviewCard`/`rateReviewCard`/`restartReviewCard`/`snoozeReviewCard`/`pauseReviewCard`/
  `resumeReviewCard`/`deleteReviewCard`/`deleteReviewCardsAndEvents`); rate/restart append exactly one
  event, snooze/pause/resume append none. `applyRatingToCardInTx` is the transaction-composing primitive
  (advance card + append the rating event + run a caller `afterEvent` hook in one tx) that lets a consumer
  atomically attach its own write — e.g. Recitation's cue-strength evidence — to the same transaction;
  `rateReviewCard` is a thin wrapper over it. `reviewCardQueries.ts` maps a card row → domain `ReviewState`
  (`reviewStateFromCard`, `reviewStateColumns`, owner-scoped `getReviewCardForUser`). Consumers read schedule
  through these and never re-implement `applyRating`/`newReviewState` (guarded by
  `recitation/recitation.test.ts`, and the Notes-owned Review boundary in `notesReview/` which composes the
  shared `rateReviewCard`/`applyRatingToCardInTx` rather than re-scheduling).
- Note prompts (retained storage; the standalone Memory store/routes/web mode and the Recall MCP tools were
  retired in #662): a reviewable note prompt is a `memory_prompts` row (the table name is kept for migration
  continuity, not for a live Memory surface) — a child Entry linked by `contains` to a unified `notes` note
  (#620 — a `kind='note'` row in the single notes facet; a first-class owned Entry with ownership + chronology
  in the shared `personal_entries` facet). Since #617 an enrolled prompt owns a row in the shared `review_cards`
  substrate (below, keyed by the prompt's Entry id) with append-only history in `review_events`; the prompt row
  holds no scheduling state of its own. Prompt creation and scheduling now happen ONLY through the Notes-owned
  Review boundary (`notesReview/`, below) and note enrollment — there is no deposit/import/edit command on a
  Memory feature anymore. The two surviving prompt reads live in `notesReview/notePromptQueries.ts`:
  `getPromptRowForUser` (owner-scoped prompt-row fetch used by the Notes review/settings commands) and
  `loadNoteReviewRoutineSummary` (the note-review routine Today's board reads). Pure scheduling is
  `@whetstone/domain` FSRS (v6, via `ts-fsrs`, `fsrs.ts`); the shared review/capture DTOs live in
  `@whetstone/contracts` (`memoryContracts.ts`, slimmed to `ratingSchema`/`reviewStateDtoSchema`/
  `memoryDocumentSchema`/`captureSourceSchema`). No `/api/memory/*` or `/api/recall/*` route survives: the
  offline-gloss suggest moved to Notes (`GET /api/notes/suggest`, `noteRoutes.ts`, backed by
  `resolveOfflineGloss`) and Notes import (`notesImportCommands.ts`, #661) is the only batch note-create path.
- Notes-owned Review session (#657): `src/apps/server/src/features/notesReview/` is the Notes-owned
  boundary for reviewing DUE note prompts one at a time, served at `/api/notes/review/*` by
  `notesReviewRoutes.ts` (`registerNotesReviewRoutes`, current-user scoped, Zod-validated): `GET /next`
  (the single earliest-due active prompt as a QUESTION only — no answer in the payload — or `{ prompt: null }`
  as the calm due-complete state), `GET /prompts/:id/reveal` (resolves the answer only on demand; 404 unless
  owned with an active card), `POST /prompts/:id/rating` (`{ rating }` → advances only that prompt's shared
  card via `rateNotePrompt`, returning its next `review` state; 400 malformed, 404 not-owned/cardless). Wired
  in `http/createServer.ts` (the `notesReview` dependency option). The reveal is a persisted discriminated
  shape: `memory_prompts.reveal_kind` ∈ {`legacy_custom`, `current_note`}, enforced by the
  `memory_prompts_reveal_shape_ck` check (migration `0054_notes_review_reveal.sql`, fail-loud). `legacy_custom`
  reveals the prompt's OWN preserved answer columns; `current_note` carries no answer columns and reveals the
  note's LIVE canonical `body_doc`/`body_text` (editing the note changes the reveal in place). The pure
  `resolveNoteReveal` (`notesReviewReveal.ts`) switches on the discriminant; queries in `notesReviewQueries.ts`,
  the rating command reuses the shared review boundary (`rateReviewCard`) in `notesReviewCommands.ts`. All
  legacy write paths deposit `legacy_custom`; `current_note` prompts are produced by note enrollment (#658):
  `notesReviewEnrollment.ts` (`getNoteReviewStatus` read + `enrollNoteInReview` write, served at
  `GET|POST /api/works/:workEntryId/notes/:noteEntryId/review[/enrollment]` in `notesReviewRoutes.ts`) turns a
  saved anchored note into exactly ONE `current_note` prompt + ONE active shared card (retention 0.90, due now,
  no copied answer). Enrollment is idempotent under a `SELECT … FOR UPDATE` on the note's `personal_entries` row
  and enforced at most once per note by the `memory_prompts_one_current_note_per_note_uq` partial unique index
  (migration `0055_note_review_enrollment.sql`); `getNoteEnrollmentTarget` (`notes/noteQueries.ts`) supplies the
  non-null anchor snapshot as the read-only Question and rejects Marks/standalone notes as not-enrollable.
- Notes home — the owner-scoped note surface (#659): the `notes` feature owns generic, owner-scoped CRUD +
  search for EVERY owned note (anchored, standalone, imported, or a Mark), independent of any work. Server:
  `noteRoutes.ts` serves `GET /api/notes` (one recency-ordered list — `updated_at` desc, entry-id tiebreak —
  with each note's rolled-up Review projection; `?work=<id>` narrows to that work's anchored notes and
  `?search=<q>` runs the note-centric search across body, anchor snapshot, prompt questions, and legacy
  answers), `GET|PATCH|DELETE /api/notes/:noteEntryId`, and `POST /api/notes` (creates a standalone
  `kind='note'`, `capture_source='manual'` note with no anchor). Queries live in `noteQueries.ts`
  (`listNotesForUser` recency/work/search + `summarizeNoteReview` per-note projection, `getNoteForOwner`,
  `searchNoteIds`, `listNoteReviewCards`); owner-scoped writes in `noteCommands.ts` (`createStandaloneNote`/
  `updateNoteForOwner`/`deleteNoteForOwner`, each composing the single `insertNoteInTx`/`updateNoteBodyInTx`/
  `deleteNoteInTx` primitives — guarded by `noteFacetOwnership.test.ts`). Owner-scoped Review enrollment/status
  is served at `GET|POST /api/notes/:noteEntryId/review[/enrollment]` (`notesReviewRoutes.ts` →
  `enrollNoteInReviewForOwner`/`getNoteReviewStatusForOwner` in `notesReviewEnrollment.ts`): an anchored note
  reuses its exact source (no question), a standalone note supplies the learner's question. Web: `NotesPage.tsx`
  is the single Notes home (one continuous list via `NotesHomeList.tsx`, per-row Review projection via
  `noteReviewSummaryLabel.ts`, debounced note-centric search, a 44px "New note" primary action). Opening any
  body-bearing note edits it in the shared `RichContentEditor` through `OwnedNoteEditor.tsx` (named-delete
  cascade + owner-scoped `OwnedNoteReviewSection.tsx`); the owner-scoped client lives in `notes/notesApi.ts`
  (`fetchAllNotes({work,search})`/`createStandaloneNote`/`updateOwnedNote`/`deleteOwnedNote`) and
  `notesReview/notesReviewApi.ts` (`fetchOwnedNoteReviewStatus`/`addOwnedNoteToReview`).
- Notes-owned Review settings & history (#660): the same owner-scoped boundary manages each note prompt's
  Review lifecycle over the shared Review commands (never re-implementing FSRS). Server
  `notesReview/notesReviewSettings{Projection,Queries,Commands}.ts` project a per-prompt settings row
  (reveal policy + `not_in_review`/`due`/`scheduled`/`paused` card state, never persisted) and compose
  `reviewCardCommands` for edit-question/pause/resume/restart/remove/re-add; history is keyset-paginated
  (opaque cursor) over `review_events`. Routes (`notesReviewRoutes.ts`): `GET /api/notes/:noteEntryId/review/settings`,
  `GET /api/notes/review/prompts/:id/history`, `PATCH .../question`, `POST .../pause|/resume|/restart|/card`,
  `DELETE .../card`. Web: `OwnedNoteReviewSection.tsx` discloses `NoteReviewSettings.tsx` in place (state-driven
  controls, inline keyboard confirmations, no-double-submit, stale-action list reload); client fns in
  `notesReview/notesReviewApi.ts` (`fetchNotePromptSettings`/`fetchNotePromptHistory`/`editNotePromptQuestion`/
  `pause|resume|restart|removeNotePromptCard`/`addNotePromptCardBack`).
- Import notebook lists into Notes (#661): the `notes` feature owns pasting a notebook list as many
  standalone Notes — the import surface replaced the retired Memory batch import (the Memory
  `importMemoryBatch` command was removed with the Memory experience, #662) with an owner-scoped Notes boundary. Server: `POST /api/notes/import` (`noteRoutes.ts`) →
  `importNotesBatch` (`notesImportCommands.ts`) prepares every row (mint note + prompt ids, derive plaintext
  via `documentReadableText`) then, in ONE `db.transaction`, per row composes the shared `insertNoteInTx`
  (`kind='note'`, `capture_source='import'`) + `insertCurrentNotePromptInTx` (`noteCommands.ts`) — each note
  gets ONE cardless `current_note` prompt but NO card/review event, so imports are all-or-nothing and land
  in Notes un-enrolled (no Review until deliberately added, #658). The `ImportNotesRequest`/`…ResultDto`
  contracts live in `@whetstone/contracts`. Web: `NotesImport.tsx` (opened from `NotesPage.tsx`'s Import
  action) pastes → previews the deterministic split → refines rows, driven by the pure draft state machine
  `notesImportDrafts.ts` (parse/fold via domain `notebookImport.ts`, undo-split/merge/split-off, offline
  gloss fill); `notesApi.ts` adds `importNotes`/`suggestGloss`. An imported note enrolls by reusing its
  cardless prompt's confirmed question read-only (`OwnedNoteReviewSection.tsx`, `notesReviewEnrollment.ts`
  surfaces it on the `not_enrolled` status).
- Diary capture (owned, journals only) (#571): `src/apps/server/src/features/diary/` is the single
  owned-capture surface — the retired `makeDurable/` feature (proposal generation, `timeline_entries`,
  `proposal_candidates`/`proposal_reviews`, history backfill, `makeDurableContracts.ts`, the domain
  `makeDurable.ts`) is gone; a diary capture **journals only** and never gates or slows on a proposal. The
  diary write path (`diaryCommands.ts`/`voiceCaptureCommands.ts`/`voiceCaptureWorker.ts`), the derived
  Timeline query (`diaryQueries.ts` over `personal_entries` + `diary_entries` + `notes`), and the web
  `CaptureCard`/`DiaryPage` are described in the "Diary" bullets below.
- Reading→practice nudge: retired (#601). The unsolicited Today nudge card, its `GET /api/nudge` /
  `POST /api/nudge/:chunkId/dismiss` routes, the `NudgeDto` contracts, and the `nudge_state` cooldown
  table are gone. The reading→speaking harvest on-ramp that once consumed its recent-reading-capture
  selection retired with the coach-led Practice (#603).
- Recitation direct Work-level maintenance (owned) (#577/#633/#643): `src/apps/server/src/features/recitation/`
  — a known Work enters FSRS maintenance directly; the retired passage/chaining/introduction/fading/hub
  curriculum is gone (its durable rows survive read-only as legacy history, retired from scheduling by
  migration `0053_retire_passage_scheduling.sql`). `recitationCommands.ts`: `enrollRecitation` (idempotent —
  get-or-create ONE `recitation_plan` identity Entry + `personal_entries` facet, always `maintenance`, plus
  ONE `recitation_whole_work` target Entry linked by a `contains` `entry_links` row (no facet, never on the
  Timeline) owning ONE shared `review_cards` row `seedReviewCard`ed at requested retention 0.95, due now;
  re-enrol reuses all three and re-activates a paused card; `400 work_not_found`); `recordRecitationReview`
  (owner-scoped, rates ONLY that Work-level card via `applyRatingToCardInTx`, appending exactly one
  `review_events` row, and returns the rescheduled review); `pauseRecitation`/`resumeRecitation`/
  `removeRecitation` (owner-scoped -> `not_found`, preserve the Work + source content). `recitationQueries.ts`
  (`toRecitationPlanDto`, `findRecitationPlanForWork`, `loadOwnedRecitationPlan`, `listRecitationPlans`,
  `listActiveRecitationPlans` — unpaused only, `listRecitationOverviewPlans` — ALL owned plans incl. paused,
  newest-first). `recitationReviewQueries.ts` (`loadWholeWorkTarget` joins
  the plan's target Entry to its shared card; `loadWorkSourceText` reveals the canonical source live from
  the Work's ordered non-deleted blocks — NEVER copied into recitation state; `loadRecitationReview` opens
  THAT exact Work's review by `?work=` regardless of strict due-ness, else the earliest-due Work, else null
  -> a calm Library recovery; `loadRecitationRoutineSummary` folds every unpaused plan's Work-level card
  through the pure #633 `selectRecitationWork` so Today's Recitation-due derives ONLY from whole-Work cards —
  passage/chain/introduction/ownership state never contributes; `loadRecitationOverview` folds every owned
  plan (incl. paused) with its whole-Work card into the #638 Recite-home DTO — each Work's `isDue`
  (active + unpaused + due), `nextReviewAt`/`state` read from any existing card, `paused` flag — plus the
  active due-count). `recitationTeardown.ts`
  (`deleteRecitationReviewData` tears down a target's cards+events+cue-strength evidence referentially safely,
  including any legacy passage/whole-work targets, when its Work is deleted). `recitationRoutes.ts`
  (current-user scoped, Zod-validated, `now`/`createEntryId` injected): `POST /api/recitation/enroll`
  (200 plan, 400 work_not_found), `GET /api/recitation/plans`, `GET /api/recitation/overview` (#638 the
  Recite-home DTO), `GET /api/recitation/review?work=`,
  `POST /api/recitation/plans/:id/review`, `POST /api/recitation/plans/:id/pause|resume`,
  `DELETE /api/recitation/plans/:id`; wired in `createServer.ts`/`index.ts`. `diaryQueries.ts` still joins
  `recitation_plans` into the Timeline as the `recitation` kind; `library/libraryCommands.ts` `deleteWork`
  cascades the plan's recitation targets + their shared cards/events/evidence. DTOs in `@whetstone/contracts`
  (`recitationContracts.ts`).
- Memory/Recall MCP server: retired with the standalone Memory experience (#662). The five legacy tools
  (`deposit_memory`/`list_due_prompts`/`record_review`/`search_memory`/`get_memory_prompt`) and their stdio
  entry point are gone — PRODUCT defers AI-authored prompts, and the Notes + shared Review loop is complete
  without an MCP surface. There is currently no MCP tool set; the retained `memory_prompts` table is written
  only through Notes + the shared Review substrate.
- Shared LLM seam: `src/llm/` — the one model-agnostic prompt→text boundary every server LLM caller
  (diary tidy, AI 解释) goes through. `llmModel.ts` exports the `LlmModel` type
  (`(prompt: string) => Promise<string>`), `createOllamaModel(model)` (local Ollama via the Vercel AI
  SDK over its OpenAI-compatible `/v1`, one shared `llmTimeoutMs`) and `probeOllamaModel(model)` (the
  boot health probe). This replaces the two former hand-rolled Ollama `fetch` clients and the hardcoded
  base URL; a later cloud model is a provider/base-URL swap behind the same `LlmModel` type.
- Voice input (STT) seam: `src/speech/` — `speechInput.ts` (the `SpeechInput`
  interface: `transcribe({ path }) -> { transcript, words[], language }`), `fakeSpeechInput.ts` (deterministic, for
  the mic-less `pnpm validate` gate), `whisperSpeechInput.ts` (a local OSS Whisper adapter — builds the
  offline CLI args always with `--language auto` (Whisper auto-detects, no forced-language override, #647); validates
  the word-timestamped JSON at the boundary and reads the detected `language`; maps to a `Transcription`),
  `whisperProcess.ts` (the injected execFile runner) and `speechConfig.ts` (env-driven, absent-config-
  safe `resolveSpeechInput` that stays on the fake until a Whisper binary+model are configured).
  `speechHealth.ts` (`checkSpeechHealth`, wired in `index.ts`) logs a
  boot warning when STT is on the fake, pointing at `pnpm setup:voice`. Transcript shapes in
  `@whetstone/contracts` (`speechContracts.ts`). Audio never leaves the machine; setup in
  `docs/SPEECH.md`.
- Diary (rich Entry + logical Timeline): `src/features/diary/` (#246 origin, #571 rich-Entry rework) — the
  owned diary capture. A diary artifact is a `diary_entry` whose durable body is a **ProseMirror/Tiptap
  document** (`body_doc` JSONB + `body_text` plaintext projection) built via `@whetstone/document`
  (`createTextDocument`/`documentText`), with diary facets `input_mode` (typed|voice), `language`, raw
  audio, verbatim transcript, tidied text, nullable `processing_status`/`failure_reason`. `diaryTidy.ts`
  `createDiaryTidy(chat: LlmModel)` wraps the injected model with the `@whetstone/domain` tidy prompt (drop
  fillers/false starts/repeats + light reorder, but preserve wording/meaning/voice — never upgrade
  vocabulary or translate; language-agnostic). `diaryCommands.ts`: `createDiaryEntry` is **save-first** — in
  one transaction it writes the `entries` (`diary_entry`) row, the shared `personal_entries` facet
  (owner + `occurred_at`/`created_at`/`updated_at`), and the `diary_entries` row; **typed** capture is ready
  immediately (`processing_status` null, body from the typed text), voice is the async path (below).
  `updateDiaryEntry` edits the rich `body_doc` (+ `body_text`, optional `language`) and bumps `updated_at`;
  `updateDiaryEntry`/`deleteDiaryEntry` are owner-scoped → 404 otherwise (delete removes `diary_entries` +
  `personal_entries` + `entries`). `diaryQueries.ts` derives the **logical Timeline** from `personal_entries`
  for the current user — joining `diary_entries` and `notes` into the `kind`-discriminated `TimelineEntryDto`
  (diary carries `body_doc`/`body_text`, note its markdown) and ordering/day-grouping via the pure domain
  `groupTimelineEntriesByDay` (`occurred_at` DESC, `entry_id` ASC tie-break) — never a stored Timeline
  object; `listTimelinePage` pages days newest-first via the exclusive `before` day-key cursor,
  `listDiaryEntriesForUser` is the
  full-state read facet. Diary is the `kind === "diary"` filter over that result. `diaryRoutes.ts`:
  `POST /api/diary/entries`, `GET /api/diary/timeline?before&limit`,
  `PATCH`/`DELETE /api/diary/entries/:id` (all Zod-validated, current-user scoped). No proposal card is
  returned. The tidy seam is wired in `index.ts` via `createDiaryTidy(createOllamaModel(...))`. Shapes in
  `@whetstone/contracts` (`diaryContracts.ts`).
- Async Tap-and-Talk voice capture: `src/features/diary/` (#565) — moves the durable boundary BEFORE
  speech-to-text (**save-first**). `voiceCaptureCommands.ts` (`submitVoiceCapture` saves the raw audio via
  the server file boundary, then in one transaction inserts the `entries` (`diary_entry`) + `personal_entries`
  - `diary_entries` rows with `input_mode="voice"`, server-owned owner/instants, `processing_status="queued"`,
    a placeholder empty body, and no fake transcript — persisted BEFORE any STT; `listActiveVoiceCaptures`/
    `getVoiceCaptureStatus`/`retryVoiceCapture` are user-scoped → 404, retry only a `failed` capture → 409
    otherwise, clearing `failure_reason`). `voiceCaptureWorker.ts` (`processNextVoiceCapture` atomically claims
    the oldest `queued` row → `transcribing` → `tidying`, transcribes via the STT seam, tidies, then commits
    `ready` — building `body_doc`/`body_text`/`tidied_text` from the tidied text via `@whetstone/document`;
    **no proposal generation**; a throw/empty transcript/missing audio → `failed` + `failure_reason` with audio
    kept; `requeueStalledVoiceCaptures` resets in-flight `transcribing`/`tidying` rows to `queued` at startup).
    `diaryRoutes.ts` adds `POST /api/diary/voice-captures`, `GET /api/diary/voice-captures/:id`,
    `POST /api/diary/voice-captures/:id/retry`, and `GET /api/diary/voice-captures` (`listActiveVoiceCaptures`
    — the user's diary captures with `processing_status IS NOT NULL AND != "ready"`, oldest-first — so the
    client can rebuild its pending/failed rows, #566). The Timeline query hides in-flight/failed captures
    (only `processing_status IS NULL OR = "ready"` surface). Wired in `index.ts`: `saveVoiceCaptureAudio`
    durable boundary + a `setInterval` drain loop over `processNextVoiceCapture`, `requeueStalledVoiceCaptures`
    at startup. Contracts in `voiceCaptureContracts.ts`.
- Config: `src/config/serverConfig.ts`.
- Data: `src/db/` — `schema.ts` (Drizzle), `dbClient.ts`, `migrate.ts`, `migrations/`. Tables include
  `entries` (the addressable-id spine; `type` ∈ work/reading_unit/block/note/toc_entry/**diary_entry**/**recitation_plan**/**recitation_passage** —
  `timeline_entry` retired, #571), works/authors, `reading_units`, mdast `blocks` + PM `doc_blocks`,
  `notes` (a pure content facet now: `answers_json`/`markdown_body`/`template_id` — ownership + chronology
  moved out), `personal_entries` (the shared owner+chronology facet for owned Entries — `entry_id` PK,
  `user_id`, `occurred_at`/`created_at`/`updated_at`, indexed `(user_id, occurred_at)`; a row for each
  `note`, `diary_entry`, and `recitation_plan`, none for shared-library entries), `diary_entries` (`entry_id` PK, `body_doc`
  JSONB + `body_text`, `language`, `input_mode`, raw audio/transcript/tidied text, nullable
  `processing_status`/`failure_reason`), `recitation_plans` (#577 `entry_id` PK/FK, `work_entry_id` FK +
  index, `phase` enum, `session_count`, nullable `last_session_at`, nullable `paused_at` (#608 plan-level
  pause — non-null removes the plan's cards from ALL cross-plan due/Today selection via
  `isNull(paused_at)` without deleting any progress/schedule/support/chain/history; resuming clears it)),
  `recitation_passages` (#578 `entry_id` PK/FK, `plan_entry_id` FK + index, `order_index`, start/end
  `block_entry_id` + offsets, `source_text`, `context_snapshot`, `anchor_status` enum, `support_level` enum
  (#579, default `full`), nullable `introduced_at` lifecycle marker — active iff non-null AND it owns a
  shared `review_cards` row, else queued; #618 moved scheduling off the row),
  `recitation_review_evidence` (#618 Recitation-owned cue strength keyed 1:1 to a shared `review_events`
  row: `review_event_id` PK/FK, `cue_strength`), `recitation_chains` (#580 `id` PK, `plan_entry_id`
  FK + `(plan, status)` index, `end_order_index`, `status` active/completed, timestamps) and
  `recitation_whole_work` (#580/#618 `entry_id` PK/FK to a `recitation_whole_work` target Entry, `plan_entry_id`
  UNIQUE/FK — the aggregate's schedule is a shared `review_cards` row keyed by `entry_id`, target created
  lazily on first whole-work review), links/templates, `reading_positions`, search indexes, and
  `toc_entries` (a work's authored nav-derived TOC: `entry_id` PK + `work_entry_id` FK to `entries`,
  `parent_entry_id`, `order_index`, `depth`, `label`, nullable `target_source_file`/`target_anchor`,
  indexed by work; #379). The `timeline_entries`, `proposal_candidates`, and `proposal_reviews` tables were
  dropped with Make Durable (#571).
- Features (feature-first): `src/features/<feature>/` with `*Routes.ts`, `*Commands.ts`,
  `*Queries.ts` (current: `library/`, `content/`, `notes/`, `readingPosition/`, `search/`). Routes stay thin; logic lives in
  commands/queries. `content/` ingests Markdown, EPUB, and PDF uploads. Markdown re-ingestion REPLACES a
  work's content via the domain block diff (`blockReconciler.ts` preserves matched block ids, inserts
  new, soft-deletes removed — `blocks.deleted_at` set + detached `reading_unit_entry_id` — and clears
  the work's `reading_positions` so deleting the replaced unit entries cannot dangle their FK); identical
  source is a no-op. PDF uploads (`POST …/content/pdf`) converge on the Markdown pipeline: `src/files/pdfToMarkdown.ts` (`PdfToMarkdown` seam) converts a PDF to Markdown one-shot — production spawns the isolated Docling worker (`src/files/pdf_to_markdown.py`, MIT, permissive); a deterministic fake keeps the keyless gate green with no Python — then `ingestPdf` reuses `ingestMarkdown` (golden: a PDF ≡ the equivalent `.md`). A missing toolchain (no Python/Docling/OCRmyPDF/Tesseract on the host — including an installed OCRmyPDF that cannot find Tesseract) is classified at the spawn boundary (`src/files/pdfToolchain.ts`, `PdfToolchainMissingError`) and surfaced distinctly as **503 `pdf_toolchain_missing`** ("run `pnpm setup:pdf`"), separate from a genuinely bad file's **422 `invalid_pdf`** (#510). A scanned PDF gets an OCR pre-pass first (`src/files/pdfOcr.ts`, `PdfOcr` seam, composed via `composePdfToMarkdown`): production spawns OCRmyPDF/Tesseract (`--skip-text`, permissive); the identity fake is a no-op so born-digital ingest is unchanged. EPUB uploads (`epubCommands.ts`) create the Work from OPF metadata and are
  sha256-idempotent, persisting via `blockWriter.ts`. Figure blocks have their transient image src
  resolved against the parser's extracted chapter images and stored content-addressed
  (`figureImageResolver.ts` → `imageResourceStore`), stamping `image_resource_id` + `alt`; an
  unsupported (e.g. SVG) or missing image degrades the block to caption-only, and a figure with neither
  a stored image nor a caption is dropped. Between decompose and block-write, EPUB units pass through a
  composable clean-plugin pipeline (`contentFilters.ts`, #275): ordered, individually-toggleable
  `ContentFilter` plugins (`units -> units`) registered in one place (`defaultContentFilters`); no
  filter is the identity. The first plugin (`dropPublisherBoilerplateFilter`) drops high-confidence
  publisher front/back matter units (公版书/关于我们/制作说明/联系/7sbook markers in a unit's title or
  text) so real chapters stay intact; the Markdown path can reuse the same pipeline later.
  `htmlToDocument.ts` is the server-side fidelity ingestion seam (#311, jsdom + prosemirror-model):
  one chapter's XHTML → a `@whetstone/document` PM/Tiptap doc via a `DOMParser` built from an explicit
  rules array bound to `documentSchema` (the pure package carries no `parseDOM` specs), decomposed into
  block rows; fail-loud — any unrecognized block-level element becomes an `unknown` node (raw HTML kept
  verbatim) and emits a structured evidence record, so nothing is silently dropped. A pre-parse walk
  (`hoistWrapperAnchorIds`, #516) first moves a section fragment id authored on a structural wrapper
  (`<div class="sect1" id>` / `<section id>`) onto its leading block, so section anchors survive
  unwrapping and reach the work anchor index (innermost wrapper wins; a block's own id is never
  overwritten). `ingestEpub` wires
  this into the real flow: `resolveChapters` runs `htmlToDocument` per chapter, resolves each PM
  `image` node's `src` against that chapter's stored content-addressed images (the same resolution used
  for mdast figures, via `figureImageResolver.ts`) and stamps the resolved store id onto the node's
  `imageResourceId` attr (#310/#312), then the document's top-level PM nodes are dual-written at the
  block-row boundary to the `doc_blocks` table (one row per node, keyed by the node's stable id from
  `assignNodeIds`, with `node_json` carrying the PM node and a `plaintext` column — the in-order
  concatenation of the node's descendant text via `@whetstone/document`'s `documentText` — plus an
  `anchors` JSONB column: the block's **complete** source-id → PM-node-id map `[{ anchor, nodeId }]`
  for every id-bearing node inside it (own + nested), captured by `collectBlockAnchors` before
  `stripAnchorId`, so ingestion no longer drops nested ids and the flattened work anchor index can
  resolve a cross-reference to a nested target element-precisely, #550) alongside the
  existing mdast `blocks` rows; each `doc_blocks` row is also registered as a first-class `entries` row
  (`type: "block"`) under a `contains` link from its unit, so a PM block id is an addressable anchor
  (the reader renders these PM block rows for EPUB content (#312) and stamps the id as `data-block-id`;
  mdast block storage stays as the Markdown fallback until Markdown ingestion also writes `doc_blocks`);
  the
  surviving units' fail-loud evidence is logged through the injected
  `ContentDependencies.ingestionLogger`. Both writers
  bulk-insert through `insertBatching.ts` (`insertInBatches` chunks every multi-row INSERT under PostgreSQL's 32767
  bind-parameter limit so large works persist; `assertContentPersisted` turns a silent zero-row
  rollback into a 5xx instead of a false 201). After the units are written (so `reading_units.source_file`
  exists), EPUB ingest persists the authored **nav-derived TOC**: when `epubSource` surfaced a nav doc,
  `tocWriter.ts` (`flattenNavTree` → `writeTocEntries`) parses it (`epubNav.parseNavDocument`), resolves
  each entry href against the nav document's own path (`resolveRelativeHref`, #366) into a
  `(target_source_file, target_anchor)`, and writes the flattened tree to `toc_entries` (pre-order
  `order_index`, `depth`, `parent_entry_id`; each entry also a first-class `entries` row of type
  `toc_entry`); fail-soft — no nav / empty parse persists nothing (#379). Blocks carry `work_entry_id`, so notes on
    soft-deleted (unit-detached) blocks stay addressable. The reader no
    longer transfers the whole work: `contentQueries.ts` exposes the lazy-reader read endpoints
  (`loadWorkStructure` / `loadReadingUnitContent` / `locateBlockUnit` / `loadWorkAnchorIndex`):
  `GET …/structure` (units + block counts, no content), `GET …/units/:unitId/content` (one unit's
  ordered blocks — both the mdast `blocks` and the PM `docBlocks`: `{ entryId, node, orderIndex, type }`,
  the reader's render source), `GET …/blocks/:blockId/unit` (block → owning unit for deep-links /
  jump-to-note, via `locateBlockUnit`), and `GET …/anchors` (the **work anchor index** — the
  **complete** source-id → PM-node-id map flattened from every block's `doc_blocks.anchors` JSONB
  (one entry per id-bearing node, block + nested), keyed by `(reading_units.source_file, anchor)` →
  `{ blockEntryId, nodeId, unitEntryId }`, so a reference to a **nested** target resolves and jumps
  element-precisely — not just to the owning block — and an id reused across chapters resolves per
  source file, not by collision; backs work-scoped internal-reference resolution, #366/#550), each
  404ing an unknown/out-of-work target. `GET …/structure` additively carries the work's nav-derived **table of contents** when it has
  one (`tableOfContents?: TocEntryDto[]` — pre-order authored entries with `depth`/`parentEntryId`/`label`
  and a `targetUnitEntryId` resolved from each entry's `target_source_file` via `reading_units.source_file`,
  plus an optional `targetAnchor`; omitted, never empty, for a nav-less work, so `readingUnits` is
  unchanged and the reader falls back to the flat unit list, #379). A block id is resolved over **both**
  substrates — legacy mdast `blocks` and PM `doc_blocks` — through the shared `db/addressableBlocks.ts`
  union (`addressableBlocks`), so `locateBlockUnit`, `findBlockInWork`, and the note-listing joins
  resolve a PM-rendered block id wherever a legacy block id resolves (#312). Search resolves the same
  way per unit (its rendered substrate; see `search/`). (The whole-work `GET …/content` route was removed; admin composes
  structure + per-unit client-side.) `notes/` is the single Notes-owned boundary for the ONE unified note
  facet (#620): `insertNoteInTx`/`updateNoteBodyInTx`/`deleteNoteInTx` are transaction-composing primitives
  that every writer composes (Reader capture; the owner-scoped Notes-home commands `createStandaloneNote`/
  `updateNoteForOwner`/`deleteNoteForOwner`; the `importNotesBatch` notebook import), so there is exactly one
  note writer, one body updater, and one owner-scoped delete cascade (an owned note's delete tears down its
  prompts + shared review cards/events through the same cascade — guarded by `noteFacetOwnership.test.ts`).
  Review is behavior applied to a note, never a second note store: enrollment adds a `contains`-linked
  `memory_prompts` prompt + shared card over this boundary (`notesReview/`), and the standalone Memory
  composer/delete path was retired in #662. It serves note templates and creates, lists, edits,
  and deletes notes (a Reader note/mark is block-anchored via an `annotates` link and scoped to a work
  through `blocks.work_entry_id`; a standalone/manual note is unanchored — `note_anchors` LEFT-joined),
  and lists every note the current user owns across works for the Notes mode (`GET /api/notes` →
  `listNotesForUser`, joined to work + author, ordered by work title then note id);
  templates are seeded from the domain on boot
  (`seedNoteTemplates`). `readingPosition/` durably stores each reader's position per (user, work) —
  the last open reading unit + an optional block anchor — in `reading_positions` (composite
  `(user_id, work_entry_id)` PK), upserted via `PUT` and read via `GET /api/works/:id/reading-position`;
  the server is the source of truth so resume survives a localStorage clear / new browser / other device.
  `getLatestReadingPosition` adds the cross-work seam the Today home composes — the user's single
  most-recently-`updated_at` position joined to `work_meta` for the title — served user-scoped via
  `GET /api/reading-position/latest` (`{ position }` or an explicit null when none); the upsert bumps
  `updated_at` so "most recent" tracks the last save. `getWorksWithReadingPosition` serves the shelf's
  Read-vs-Continue distinction — the user-scoped set of work ids that have any saved position — via
  `GET /api/reading-position/works` (`{ workEntryIds }`).
  `search/` is read-only block-level library search: `GET /api/search?q=` validates the query, then
  `searchQueries.searchBlocks` runs a case-insensitive `ILIKE` substring scan over each unit's
  rendered substrate — the PM `doc_blocks` for a unit that has any (EPUB), else the legacy mdast
  `blocks` (Markdown) — as a `UNION` whose legacy half excludes units that already have `doc_blocks`
  (a `NOT EXISTS` guard), so a hit's `blockEntryId` equals the reader's rendered `data-block-id` and
  deep-links to the right block (#312). Joined to work + author, ordered by reading order, capped at
  `searchResultLimit`, LIKE wildcards escaped; v0 is a substring scan, not ranked FTS
  (PRODUCT.md "v0 search").
  `today/` composes the Today board (#610): `todayQueries.loadTodayBoard` fetches each source guarded by
  its own try/catch (so one throwing marks only that source failed, never blanking the board) — the
  recitation routine from `recitationReviewQueries.loadRecitationRoutineSummary`, the note-review routine from
  `notesReview/notePromptQueries.loadNoteReviewRoutineSummary`, Continue reading/writing from the readingPosition/authoredWorks
  queries — folds them through the pure `@whetstone/domain` `composeTodayBoard`, sets `date` =
  `localDayKey(now, timeZone)`, and `todayRoutes.registerTodayRoutes` serves `GET /api/today` (userId +
  `getLearnerTimeZone`, response validated via `todayBoardResponseSchema`); wired in `createServer.ts`/
  `index.ts`. The composer, DTOs (`todayContracts`), and the additive recitation-session `due.nextDueAt`
  Today consumes are the whole read model — Today persists no task or completion rows.
- Source files: `src/files/sourceFileStore.ts` — persists uploaded/manual Markdown and uploaded
  `.epub` bytes under a server-generated path with sha256 (path-traversal-guarded) for provenance
  only; blocks remain the source of truth. `src/files/epubSource.ts` — the EPUB parsing boundary
  (`@lingo-reader/epub-parser`): bytes in, normalized metadata and ordered chapter HTML out (injected
  so commands test against a fake parser); it additively surfaces the authored nav document
  (`ParsedEpub.nav?`) via `readNavDocument`, reading the nav resource's bytes straight from the archive
  (the manifest's `selectNavResource` item) and decoding UTF-8, fail-soft (#379). It guards the upload with `src/files/zipArchive.ts`
  (`isZipArchive`, a dependency-free ZIP signature/EOCD check) and rejects non-ZIP bytes before the
  library runs — the library otherwise hangs and emits a process-crashing unhandled rejection on
  non-EPUB input. `src/files/epubNav.ts` — a pure, no-I/O parser for an EPUB's authored navigation:
  `parseNavDocument` reads an EPUB3 `nav.xhtml` toc or an EPUB2 `toc.ncx` navMap into a normalized
  nested nav tree (`NavEntry{ label, href, children }`; fail-soft, never throws), and `selectNavResource`
  picks the nav resource from the OPF manifest (EPUB3 `properties~="nav"`, else the ncx media type).
  Parsing only — no persistence/reader/href resolution; consumed by the nested nav-tree 目录 (#379:
  `epubSource` surfaces the nav doc → `tocWriter` persists `toc_entries` → `/structure` serves it →
  `ReaderToc` renders it).
  `src/files/imageResourceStore.ts` — content-addressed image
  store (sha256-keyed, so identical bytes dedupe to one resource) under `imageResourcesDir`, with a
  write-time content-type allowlist (PNG/JPEG/GIF/WebP; SVG and others rejected); served read-only by
  `src/features/images/imageRoutes.ts` (`GET /api/images/:id`, id is the content hash, allowlist
  re-checked at the boundary, no traversal/remote fetch, unknown id → 404). Used by EPUB ingest to
  store figure images (`content/figureImageResolver.ts`) and read back by the reader's `ReaderFigure`.
- Outbound lookup foundation: `src/lookup/` — reusable boundaries for calling external services and
  caching results. `httpClient.ts` (typed GET text/JSON with timeout + custom headers; normalizes
  failures to typed `HttpError`; injected `fetch`), `lookupCache.ts` (keyed TTL cache, injected clock;
  in-memory impl), `jsonValue.ts` (dependency-free narrowing of untrusted JSON). Vocabulary lookup is
  monolingual and key-free, built on free sources and composed by role into the shared
  `DictionaryEntry` (`@whetstone/contracts`): `wordnetProvider.ts` is the offline backbone — the
  bundled, MIT-licensed `wordpos`/`wordnet-db` database (the real instance is built only in the
  composition root and injected behind a `WordPosLike` seam so the provider tests with fakes); it
  groups synsets by part of speech and supplies the synonym sets. `freeDictionaryProvider.ts` is the
  Wiktionary provider over the no-key community Free Dictionary API (pronunciation/IPA, examples,
  etymology, senses). `englishLookup.ts` composes the two by role: pronunciation + etymology from
  Wiktionary; senses Wiktionary-primary with WordNet fallback; synonyms from WordNet (∪ Wiktionary)
  merged in by part of speech — never aligning senses across sources. For Chinese, `cedict.ts` is a
  pure, bundled CC-CEDICT provider: it parses the dataset text into an in-memory `Map` keyed by both
  Simplified and Traditional headwords and maps matches into a `DictionaryEntry` (pinyin as
  pronunciation, glosses as part-of-speech-less senses). The 8MB CC-CEDICT dataset lives in
  `src/lookup/data/` (`cedict.u8.gz` + a `README.md` recording CC BY-SA 4.0 attribution); the
  composition root (`src/index.ts`) reads + gunzips it via `node:zlib` (resolved from
  `import.meta.url`) and `pnpm build` copies `src/lookup/data` into `dist/lookup/data`. For Chinese
  the lookup is **Chinese-first** (#272): `moedictProvider.ts` is the networked 萌典 (moedict) provider
  over the open `https://www.moedict.tw/{word}.json` API — it strips the HTML markup, groups 釋義 by
  詞性 with 例句/書證 as examples, and time-boxes the request — surfaced as the primary tab.
  `zhWiktionaryProvider.ts` is a second Chinese tab (#296): the networked zh.Wiktionary provider over
  the MediaWiki `action=parse&prop=wikitext` API (CC BY-SA), whose pure `parseZhWiktionary` extracts
  the 漢語/汉语 language section, groups each part-of-speech subsection's `# ` definitions (markup
  stripped via `stripWikiMarkup`, capped) and an optional 詞源 etymology — richer classical senses
  than 萌典; a no-Chinese-section/no-sense page is `null` (empty tab, #306) but a transport failure
  throws so the lookup surfaces that tab's error only (#196). CC-CEDICT's English glosses are the next
  tab, then the optional local-LLM **"AI 解释"** aid last (`zh-CN`/`zh-TW` →
  `["moedict", "zhwiktionary", "cedict", "llm"]`). `explainProvider.ts` is that pure LLM-explain seam
  (#341): `resolveExplainer` yields a real Ollama-backed explainer (built on the shared `src/llm/` seam via
  `createOllamaModel`) only when `EXPLAIN_MODEL` is set (the network call is wired in the coverage-excluded
  `index.ts`), else
  a provider that returns `null` so the tab shows an honest "unavailable" state — a labeled contextual
  gloss (the selection's block text is passed as `context`), never an authoritative dictionary entry.
  Each
  `LookupSource` declares the `languages` it serves; `lookupService.ts` resolves the one requested
  source+language tab (English → WordNet/Wiktionary; Chinese → 萌典/zh.Wiktionary/CC-CEDICT/AI 解释),
  returns its composed
  `DictionaryEntry`, and caches by `language:source:term:context`. Every contributing source's attribution
  rides in
  the entry's `sources`. `wordpos` runs its bundled-index build step via pnpm's `allowBuilds` in
  `pnpm-workspace.yaml`. The adapters are pure (tested against canned data via the fake transport /
  sample text, plus one offline integration test against the real WordNet database).
  The route lives in `src/features/lookup/lookupRoutes.ts` (`GET /api/lookup?term=&language=`,
  language is `en`/`zh-CN`/`zh-TW`, thin: validates the query contract, delegates to the service).
- Backup/restore (#600): `src/data/` owns verified whole-instance backup and restore. Pure, covered
  modules — `archive.ts` (versioned single-ZIP format: `manifest.json` + gzip database dump + per-root
  files, with SHA-256 checksums and `verifyArchive`), `dataRoots.ts` (durable file-root inventory from
  server config), `metadata.ts` (app + schema version), `fileTree.ts` (collect/write a root),
  `restoreSafety.ts` (rejects traversal/absolute/drive/backslash paths and unknown root names in the
  archive before any write), `backup.ts`
  and `restore.ts` (orchestrators with injectable I/O), and `cli.ts` (arg parse + output/error mapping).
  The thin, coverage-excluded `backupCli.ts`/`restoreCli.ts` wire real PGlite (`dumpDataDir`/`loadDataDir`)
  and fs for `pnpm data:backup -- --output <artifact>` / `pnpm data:restore -- --input <artifact>
--target <empty-dir>`. Backup refuses an in-memory `DATABASE_DIR` and an existing output; restore
  verifies before writing, refuses a non-empty target, runs migrations, and integrity-probes the restored
  database. Operator guide: `docs/BACKUP.md`.
- Tests colocated `*.test.ts`. Invariant: PostgreSQL is the content source of truth; blocks are rows.

### `src/apps/web/` — React + Vite PWA

- Installable PWA (#438): `vite.config.ts` runs `vite-plugin-pwa` (generateSW, `registerType:
"autoUpdate"`) — the manifest (`display: standalone`, Day-token `theme_color`/`background_color`) +
  a Workbox service worker precaching the built shell; icons live in `public/` (committed `icon.svg`
  source + generated PNGs incl. a 512 maskable + 180 apple-touch), iOS/desktop meta in `index.html`.
  The SW is off in dev and the E2E/screenshot harnesses (`devOptions.enabled=false` +
  `WHETSTONE_DISABLE_PWA=true`); `assert-pwa-build.mjs` fails the build if `dist` lacks the
  manifest/SW/icons. The server serves `manifest.webmanifest` + `sw.js` at root via `staticWeb.ts`.
- Entry: `src/main.tsx` (imports the self-hosted fonts + `styles/theme.css`, mounts `<MotionConfig
reducedMotion="user">` + `<HashRouter>`); root `src/App.tsx` renders the routed shell.
- Host runtime config (#445): `src/shared/runtime/` is the host↔web-core seam so the one bundle runs
  as browser web, desktop, or iOS. `apiRuntime.ts` holds the canonical `apiUrl(path)` resolver every
  feature API call goes through (never a hardcoded `/api`), plus `bootstrapApiRuntime(window)` which
  the `main.tsx` boundary calls once before render. A native shell injects
  `window.__WHETSTONE_HOST_CONFIG__ = { platform, apiBaseUrl }` (validated by
  `resolveHostRuntimeConfig` in `@whetstone/contracts`); browser web injects nothing and defaults to
  same-origin `/api`. An invalid injection makes `main.tsx` render a blocking startup error (fail
  loud) instead of starting with a wrong base.
- App shell + routing: `src/app/` — `AppRoutes.tsx` nests the modes under the `AppShell` layout
  route (Today = `TodayPage` at the index route — the app's proactive landing, Library =
  `LibraryMode` at `/library` — the shelf `AdminLibraryPage` plus an on-demand "Manage content"
  `Sheet` over `WorkContentPanel`, Reader = `ReaderPage`, Notes = `NotesRoute`→`NotesPage` at `/notes`
  (reads `?work=<id>` to narrow to a single work; also the target of the primary nav — see below),
  Review = `NotesReviewPage` at both `/notes/review` (canonical) and `/recall` (compat redirect, #662),
  Search = `SearchPage`, Recite = `RecitePage` at `/recite` — the Recite home listing enrolled Works with
  their due/next-review state (#638), Diary = `DiaryPage`, Write =
  `AuthoredWorkPage` at `/write` — the immersive authored-Work editor, reads `?work=<id>`; `/memory`
  redirects (history-replace) to `/notes` and `/recall` to `/notes/review` (#662 retired the standalone
  Memory/Recall pages — the redirects read live due/card state from the DB, never reset it); a trailing
  `path="*"` catch-all renders `NotFoundPage` so any unknown hash route — including the retired
  `#/practice` — resolves to the calm not-found page inside the shell); `AppShell.tsx` is the responsive
  frame (one `Primary` `<nav>` styled as a desktop sidebar / mobile bottom-bar, wrapped in `SafeArea`, plus
  the single `ToastViewport` live region). `navigation.ts` holds the **five** primary destinations — Today,
  Library, **Recite** (`/recite`), **Notes** (`/notes`), **Diary** (`/diary`) (#638) — plus the pure
  `activeDestination(pathname)` mapping every secondary route to its owning parent so the parent tab stays
  truthfully active (Reader/Write → Library, Recitation review → Recite, note Review + retired Memory/Recall
  → Notes); the destinations render as a **single non-wrapping row of ≥44px targets** on mobile
  (#390, #662, #638). **Search is a persistent shell utility** (a `Link` to `/search` in the top bar beside
  the `ThemeToggle`), not a primary destination. Reader, Review, and the Recitation review keep their routes
  but are NOT primary: Reader/Write are secondary surfaces under Library opened from context, the note Review is reached
  from Notes/Today, and the whole-Work Recitation review is reached from Recite (its "Back to Recite"
  control) or a contextual `?work=` deep link. Each secondary route's parent stays visibly active via
  `activeDestination` (e.g. `/reader` and `/write` keep Library active, `/notes/review` keeps Notes active,
  `/recitation` keeps Recite active). The `ThemeToggle` is shell chrome in a slim top bar (never a tab, so it cannot
  wrap the mobile row). Every routed surface — including `/reader` and `/write` — is framed by the one shell
  (#638): the primary nav and Search utility stay present with the parent (Library) visibly active, and each
  secondary surface additionally provides its own explicit back path (e.g. the reader's "Back to Library").
  Routing is hash-based (origin-independent for file/Capacitor/Tauri); tests use
  `MemoryRouter`.
- Base UI primitives: `src/shared/ui/` — `SafeArea` (`100dvh`/`svh` + safe-area insets, never
  `100vh`), `Button` (token variants via `cva`; a `pending` prop shows a `Spinner`, sets `aria-busy`,
  and disables so an in-flight action cannot double-submit), `Sheet` (Radix Dialog: focus trap +
  dismissal; right side panel on desktop / bottom sheet on mobile via `useMediaQuery`; tokenized Framer
  spring honoring reduced motion; splits its `Dialog.Content` into an un-transformed, un-clipped
  `.sheet-content-root` holding both the animated `.sheet-panel` and a sibling `.sheet-floating-layer`
  host, and wraps `children` in a `FloatingLayerProvider` pointing at that host so editor menus portal
  above the overlay from inside the dialog's stacking + focus scope, #645). `FloatingLayer.tsx` is that
  shared boundary: a context whose value is a `() => HTMLElement` container getter (default
  `document.body`) with a `useFloatingLayerContainer()` hook — the one seam a Sheet threads into every
  floating surface so no per-menu z-index patching is needed. Loading/pending state has two shared pieces: `Spinner.tsx` (CSS
  spin under normal motion; under reduced motion the global animation freeze stops the rotation and
  the `loadingSpinner` class keeps it active with a reduced-motion-safe opacity pulse so it never
  freezes into a static icon) and `LoadingIndicator.tsx` (spinner + label as a polite
  `aria-busy` `status`) — used for every page/section loader. App-wide result notifications live in
  `src/shared/ui/toast/`: `ToastProvider.tsx` owns the auto-dismissing queue and exposes `useToast()`
  (`success`/`error`); `App.tsx` wraps the app in it and `AppShell` mounts the one `ToastViewport.tsx`
  live region that renders the presentational `Toast.tsx` (success = polite `status`, error = assertive
  `alert`). Components use semantic token utilities only.
- Design system (PRODUCT.md "v0 design language"): `src/styles/theme.css` defines the Tailwind v4
  `@theme` semantic tokens (OKLCH + hex fallback) with Day defaults and `.dark` Night overrides
  (class strategy), self-hosted Inter/Source Serif 4, the language-aware reading stack, and motion
  vars. `src/shared/theme/` is the theme controller (`theme.ts` pure rules, `useTheme.ts` applies the
  `.dark` class + persists, `ThemeToggle.tsx` the sun/moon icon button placed as app-shell chrome in a
  slim top bar — not a nav tab (#390)); `src/shared/motion/motion.tokens.ts` holds the motion tokens and `motion.ts`
  the `withReducedMotion` guard (behavior). The legacy `styles.css` is kept until screens migrate to tokens.
- Shared editing: `src/shared/editor/` is the cross-feature rich-content boundary (#570).
  `RichContentEditor.tsx` mounts the single `@whetstone/document` extension set through Tiptap React,
  exposes compact/full presentations over one live document (a chrome-free surface — no permanent
  toolbar), and emits validated detached JSON on change/save; `editorDocument.ts` owns empty-document
  creation, validation/cloning, equality, and safe authored-link normalization. Inline formatting is
  contextual (#589): a Tiptap `BubbleMenu` shows `EditorFormattingMenu.tsx` (Bold/Italic/inline-code +
  a Radix link form, toolbar roving focus, Escape-to-dismiss) beside a live text selection; its
  visibility gate is the pure `bubbleFormatting.ts`. All four floating surfaces (formatting toolbar,
  link form, slash menu, block-actions menu) read `useFloatingLayerContainer()` and portal into that
  shared container — `document.body` by default, or a Sheet's above-overlay host when hosted in one
  (#645). The keyboard-first slash menu (#588) is one shared
  seam: `blockCommands.ts` is the single block-command catalog (id/label/aliases/`isAvailable`/`appendTo`)
  that later block menus reuse, `slashCommandContext.ts` gates where `/` may open, `SlashCommandMenu.tsx`
  is the ARIA listbox, and `slashCommand.ts` wires `@tiptap/suggestion` (trigger, positioning, dismissal)
  to them; a focused empty paragraph shows a decoration-only `Type / for commands` hint the reader never
  mounts. The contextual block gutter (#590) reuses that same catalog: `blockGutterCommands.ts` is the
  pure block command/query module (turn into, insert above/below, duplicate, move up/down, delete) that
  preserves node ids, `BlockActionsMenu.tsx` is its Radix dropdown (with disabled states), and
  `blockGutterHighlight.ts` is the transient block-wash plugin. `BlockGutterHandle.tsx` wraps Tiptap's
  official `@tiptap/extension-drag-handle-react` grip (reveal-on-hover, drag-to-reorder) — a browser-only
  detached-portal seam, coverage-excluded and covered by `e2e/tests/editor-block-gutter.spec.ts`;
  keyboard (Shift+F10) and a touch/coarse-pointer "More block actions" trigger reach the same menu. The
  drag-handle peer graph pulls in `@tiptap/y-tiptap`/`extension-collaboration`, but collaboration/Yjs is
  not enabled (no `Collaboration` extension or `Y.Doc` is constructed). Block transforms and undo/redo
  live on the slash menu, gutter, and keyboard, not a toolbar. Persistence
  and autosave policy stay with consuming features.
- Features: `src/features/<feature>/` with page + `*Api.ts` (current: `library/`, `content/`,
  `reader/`, `notes/`, `lookup/`, `search/`, `diary/`). `search/` is the Search mode: `SearchPage.tsx` is a query
  field whose `searchApi.searchLibrary` hits `GET /api/search`, rendering block-level hits that each
  deep-link the reader to the work/block (`#/reader?work=&block=`), with explicit empty/error states.
  `library/` is the shelf-first admin home: `AdminLibraryPage.tsx` shows works as cards
  grouped by author (`groupWorksByAuthor.ts`) with an "Add work" `Sheet` dialog, and a single
  **Upload** control — the one file front door — that accepts `.epub`/`.pdf`/`.md` and creates a new
  Work (#417). It routes by type via the shared `shared/files/fileType.ts` `detectUploadKind`
  (MIME type first, extension fallback): an EPUB ingests
  straight to a Work (`libraryApi.ingestEpub` posts the raw bytes, OPF metadata authoritative), while a
  PDF/Markdown (no reliable metadata) opens the same **Add work** sheet pre-filled with the filename's
  title, then on submit creates the Work and ingests the held file into it via the content feature's
  `contentApi.ingestPdf`/`ingestMarkdown`. The Library is **read-first** (#640): each card leads with one
  primary action — a reader link (`#/reader?work=<entryId>`, labelled **Continue** when the work has a
  saved reading position, else **Read** — armed by `libraryApi.fetchWorksWithReadingPosition` →
  `GET /api/reading-position/works` → the set of work ids with a position) — and folds the rest into one
  ≥44px overflow menu (`WorkOverflowMenu.tsx`, Radix `DropdownMenu`, `modal={false}`, accessible name
  `More actions for <title>`): **I can recite this** / **Open in Recite** (`#/recite`) → **View notes**
  (`#/notes?work=<entryId>`) → **Edit document** (`#/write?work=`) for authored works else **Manage
  content** (emits `onManageContent`) → separator → **Delete work** (destructive). Recitation *status*
  never appears in Library — Recite owns it. The header's file-and-create controls collapse into one
  ≥44px **Add** menu (`LibraryAddMenu.tsx`): **Upload file** (`.epub, .pdf, .md`), **New document**,
  **Add work manually**; class maps for both menus live in the coverage-excluded
  `libraryMenu.tokens.ts`. **Upload file** opens the same file front door as before — an EPUB ingests
  straight to a Work, a PDF/Markdown opens the pre-filled **Add work** sheet. Creating a work auto-opens
  its Manage-content sheet (add content right after create); an EPUB import does not. **New document**
  (#576) opens a minimal sheet (title/type/language — the current user is the author) that calls
  `authoredWorks/authoredWorkApi.createAuthoredWork` and hash-navigates into the editor
  (`#/write?work=<id>`); works the current user authored (loaded via `listAuthoredWorks`) carry an
  **Authored** badge and use the same read-first primary action (Read/Continue → `#/reader`), with
  editing available as the overflow's **Edit document** rather than competing on the card (#640). `reader/` is **目录-driven and lazy-loads one reading unit at a time** (no whole-book
  transfer or freeze): it fetches the lightweight `…/structure` first (`buildReaderStructure`) and pulls
  each unit's blocks on demand via `…/units/:id/content` (`readerApi.ts`: `fetchWorkStructure` /
  `fetchUnitContent` / `locateBlockUnit` / `fetchWorkAnchorIndex`), with an explicit per-unit loading
  state and an error+Retry;
  `readerModel.ts` carries each block's stored mdast for direct, re-parse-free rendering (no Markdown
  round-trip; `blockToMarkdown` stays for internal Markdown serialization);
  `readerNavigation.ts` holds the pure unit helpers (TOC labels, clamp, unit-by-entry-id, work-level
  progress, `firstSubstantiveUnitIndex`) and `readingPosition.ts` resolves the opening unit (deep-link
  `?block=` via the locator, else saved position, else the **first substantive unit**, skipping
  front-matter-like units that carry no substantive text — `hasSubstantiveText` on the structure DTO,
  computed server-side; #394); a de-emphasized `FrontMatterNotice.tsx` renders a "Start reading"
  affordance when the reader is intentionally on front matter; `ReaderToc.tsx` is the 目录 — a controlled,
  dismissable drawer (opened from the ReadingHeader 目录 tool over a backdrop, never a persistent
  sidebar). When the structure carries a nav-derived `tableOfContents` (#379) it renders the **authored
  nav tree** as a **collapsible hierarchy** (#380) — indented by `depth` (as `data-depth`/`--toc-depth`),
  a per-parent disclosure control (`aria-expanded`, ≥44px, Enter/Space) that hides descendants when
  collapsed, with the active entry's ancestors auto-expanded (local UI state, not persisted) and the
  current entry `aria-current` — and selecting an entry navigates via the #366 resolver (`resolveTocEntryNavigation` in
  `readerNavigation.ts` → open the target unit, and when the entry has a `targetAnchor` scroll+highlight
  it, reusing `ReaderPage`'s `onActivateAnchor`/`jumpToBlock`; unresolvable entries no-op); a nav-less
  work falls back to the flat unit list with the current one marked (the `Section N` label fallback stays
  on that path only). `ReaderPage.tsx` is the immersive single-column reading room: a work is opened from the
  Library via `?work=` (no in-reader work-picker or page heading; with no work open it shows an explicit
  "Open a work from your Library" empty state), with a back-to-Library hash anchor always reachable. It
  keeps an `activeUnitIndex` and the active unit's load state, fetches that unit's blocks when it opens
  (TOC select / jump / deep-link / position restore all switch the unit then scroll once its blocks land),
  renders only that unit. The reader's render path is now the **PM document model** (#312 live swap):
  each block's persisted ProseMirror node (the unit's `doc_blocks`, #311, served as the content DTO's
  `docBlocks`) is rendered to React through `@tiptap/static-renderer` via `PmDocument.tsx` — the
  per-block `PmBlock` export (so `ReaderBlockView` stays memoized per block, perf #72, rather than
  re-rendering the whole unit). `PmDocument` supplies an explicit per-node React mapping covering every
  #310 node type (the specs carry no `renderHTML`), stamps `data-block-id` = the PM node's stable
  UniqueID on each top-level block (so notes/position/search/selection anchor by block + offset),
  resolves internal references **work-scoped** through the work anchor index (`referenceResolver.ts`
  builds `resolve(target)` → `{ blockEntryId, nodeId }` and a `canResolve(target)` predicate from
  `fetchWorkAnchorIndex`; `onActivateAnchor` first tries a same-unit DOM
  anchor, then resolves `(sourceFile, anchor)` → block → the existing cross-unit `jumpToBlock`, so
  footnote/endnote markers **and same-work `<a>` cross-references** now navigate **across
  chapters/files**, #366/#368; the jump is **element-precise** (#550): `PmDocument` stamps
  `data-anchor-id` onto each nested id-bearing node (via the per-block `anchorByNodeId` map derived
  from the complete index), and `scrollToBlock` prefers that `[data-anchor-id]` element over the block
  top, so a cross-reference to a nested heading/figure lands on the exact element; an unresolvable
  same-work reference renders **inert** (a `canResolve` gate on `LinkMark`/`FootnoteMarker`), never a
  live dead button — after any such jump (marker, cross-reference, or a location-changing
  TOC entry) `ReaderPage` captures the origin (`returnPoint.ts` — pure capture/no-op/label rules) and
  shows a quiet, persistent single-level **Back pill** (`ReaderBackPill.tsx`) that returns to the exact
  block, replacing on each new jump with no timeout (#549) — a same-work `<a>` parses to the document
  schema's `link` **mark**
  (`nodes.ts`; kept inline so #340 CJK spacing survives, `见周髀之术`), stamped with a resolved
  `targetSourceFile` at ingest like a footnote (`figureImageResolver.ts`), and rendered by
  `PmDocument.tsx`'s `link` mark mapping as an inline jump control; an external/cross-work link is
  ingested `inert` and rendered as styled non-navigating text, never a live `<a href>`), and prints
  the `unknown` fallback as inert escaped text (never `dangerouslySetInnerHTML`, no fetch). It reuses the
  `.reader` typography/theme classes; `PmDocument.tokens.ts` holds its presentational
  heading-tag/callout-kind class maps. A Markdown work with no PM blocks falls back to the legacy mdast
  path (`mdastBlock.tsx`: `mdast-util-to-hast` → `hast-util-sanitize` → `hast-util-to-jsx-runtime`, no
  Markdown re-parse, sanitize schema disallows `img`) until Markdown ingestion also writes `doc_blocks`.
  A `figure` block renders a real `<figure>` (`ReaderFigure` in `ReaderPage.tsx`): for a PM figure the
  stored image is read from the PM `image` node's `imageResourceId` (+ `alt`) and the caption from its
  `figureCaption` child; for an mdast figure from the block's image fields. Either way the image is
  served from `GET /api/images/:id` (lazy, display-only, not selectable) above its
  still-selectable/annotatable caption, degrading to caption-only when the image is absent
  (unsupported/missing at ingest) or fails to load at runtime. The image is a focusable `<button>`
  trigger that opens `ImageLightbox.tsx` (#334) — a centered, fit-to-viewport `@radix-ui/react-dialog`
  modal (Escape/backdrop/✕ dismissal, focus trap + scroll-lock, focus-return) over a dimmed+blurred
  backdrop, showing the same `/api/images/:id` image enlarged with its caption; view-only, no route
  change. **Note highlights are render-time DOM
  decorations from the external anchor store (#313), never marks in the stored document:** at load
  `useNoteHighlights.ts` resolves each note's anchor over the rendered `.reader` blocks and wraps the
  matched range(s) in an external `noteMark` span (`applyNoteHighlights.ts`). The span **is the
  annotation's direct activation target** (#644, restoring the #555 direct annotation↔editor tie): a
  real focusable control (`role=button`, tab order, an accessible name naming the note kind + anchored
  text, clear hover/focus) that opens THAT note when activated by mouse, touch, or keyboard — inline
  prose uses the WCAG inline-text target exception (no line-height change), and the 44px Notes
  tool/list is the alternate target. There is no paragraph pencil and no reserved gutter/rail.
  `noteActivation.ts` (pure, unit-tested) holds the two product decisions: the underline's accessible
  name, and how the note ids covering an activated position resolve — a lone rich note opens its editor
  directly (targeting by `entryId`); a lone bodyless mark, or genuinely **overlapping** notes (nested
  underlines, disjoint by design #163 so this is only true overlap), open the compact chooser aside
  scoped to exactly those annotations, never the whole paragraph. Resolution is block-id + offset first (`blockText.ts` maps the
  shared character-offset model to/from DOM ranges, `spanMarks.ts` splits a span across blocks), then
  a W3C **TextQuote** re-anchor (`textHighlight.ts`, dependency-free) using the stored
  `selectedTextSnapshot` (+ `contextSnapshot` as prefix/suffix) when the offsets no longer fit (doc
  edit / re-ingest); `textHighlight.ts` also wraps a resolved range's text nodes in the highlight
  span(s).
  Cross-block notes are first-class — highlighted from the start block's tail through every middle
  block to the end block's head. A whole-block note (no offsets) draws no inline underline; it stays
  reachable through the Notes tool/list. The reader opens the
  `?work=`/`?block=` target on arrival via `AppRoutes`' `ReaderRoute`. The reading `article` is whetstone's own
  selection surface: it prevents the right-click `contextmenu` and uses `-webkit-touch-callout: none`
  with `user-select: text` so the mobile/Capacitor long-press callout doesn't collide with the
  toolbar while text stays selectable (the desktop browser selection mini-menu is a user setting,
  out of scope). `selectionCapture.ts` captures a selection as PM positions
  (`{blockEntryId,endBlockEntryId,startOffset,endOffset}` + text snapshots) straight from the rendered
  DOM via the same `blockText.ts` offset model the highlight resolver reads — so capture and re-anchor
  agree — supporting whole-block and cross-block selections; `selectionRect.ts` reads the
  Range rect for anchoring. A document-level mouse-up/key-up/touch-end release inside `.reader` opens a
  floating `SelectionToolbar` (Add note, Mark, and Look up); annotations are disjoint, so a selection
  overlapping an existing note disables Add note with a hint while Look up stays (`noteOverlap.ts`,
  `readerMarks.ts` `draftOverlapsNotes`). Confirming opens the `notes/` editor (where the
  size-preselected template is chosen), and a saved
  block's highlight is "born" via `highlightBirth.ts` — the born animation is the only save
  confirmation (no success toast, #300; a failed save still toasts an error). The per-work note list ("Your notes") opens
  in a toggled `Sheet` panel from the ReadingHeader notes tool (no longer pinned to the reading
  column); jumping back from a note card loads the unit holding the block (when it differs
  from the open one) then scrolls/focuses it via `scrollToBlock.ts`. The reader is the calm `paper` reading surface (`.reading-surface` +
  `readerPaper`, `lang` from the work for CJK measure): `ReadingHeader.tsx` is the receding reading
  chrome — a minimal title + a thin top progress line plus the one home for every reading-specific tool
  (text-size, the 目录 toggle as a contents icon, and the notes toggle; the Day/Night `ThemeToggle` is
  shell chrome, so it is not duplicated here — #638),
  laid out as a **persistent vertical icon rail docked at the bottom-right on desktop** (beside the
  reading column, always one click away — it stays put while scrolling, never receding) and a **top bar
  plus a bottom tools bar shown by default on mobile** (a center
  tap on the reading area recedes/restores it; it must not start receded, else the tools sit below the
  fold and are untappable — #511; `ReaderPage.tsx` owns the narrow-screen tap state). On mobile the
  whole chrome recedes as one through the `data-hidden` flag; on desktop only the title recedes on
  scroll-up (via `useReaderScroll.ts`) while the tool rail persists. Framed inside the app shell (#638),
  the reader does not scroll the window (`.app-safe-area` is `100dvh; overflow: hidden`): the reading
  column scrolls inside its own `.readerReadingScroll` container within the non-scrolling
  `.readerReadingMain` frame, and `useReaderScroll.ts` observes **that element** (not the window) for
  progress/recede. The immersive chrome is `position: absolute` scoped to that frame (never
  viewport-`fixed`), so it stays clear of the shell's utility bar and navigation instead of covering
  them (`readerChromeScope.test.ts` locks this). `readingSize.ts` holds the
  text-size steps (`--reading-size`); `annotationHue.tokens.ts` maps a note template to its inline
  highlight hue key (`noteMark--<hue>`, applied by `applyNoteHighlights.ts`).
  Block content (lists, code, blockquotes, tables, footnotes) renders to the PRODUCT.md readability
  targets via the `.reader` rules in `styles/theme.css` (even rhythm owned by `.readerBlock`, restored
  list markers, monospace code surface, ~66ch measure); `readerHeadings.ts` decides when a unit's
  eyebrow title duplicates its first heading (`isUnitTitleRedundant`) so the title is not shown twice,
  and `readerModel` flags heading blocks via `ReaderBlock.isHeading`.
  Reading position is durable **server** state, remembered per (user, work) — never localStorage:
  `readingPosition.ts` is the pure compute layer (`resolveOpening` picks the opening unit/block-scroll
  target from a deep link or the saved position), `readingAnchor.ts` finds the topmost visible block,
  `readingPositionApi.ts` reads/writes `GET`/`PUT /api/works/:id/reading-position` (server is the
  source of truth, so resume survives a localStorage clear / new browser / other device), and
  `useReadingPositionWriter.ts` saves the current unit + best-effort block anchor (immediately on
  unit change, debounced on scroll) so reopening a work resumes where it left off.
  `notes/` is the note feature: `noteCapture.ts` holds the `NoteDraft` type and `draftToAnchor`
  (the captured draft → note-anchor payload; the reader captures the draft from the DOM in
  `reader/selectionCapture.ts`), `SelectionToolbar.tsx` is the anchored capture toolbar, `templateHue.tokens.ts` maps a template to
  its control swatch, `NoteEditor.tsx` is the template-based create/edit editor hosted in the shared
  `Sheet` with a hued segmented template control, `NoteList.tsx` renders notes as hued cards
  (template chip + snippet + answers) with jump-back/edit/delete,
  `notesApi.ts` calls the templates/notes endpoints. The Notes mode page is `NotesPage.tsx`: it
  fetches the cross-work overview (`notesApi.fetchAllNotes`), groups it by work (`groupNotesByWork.ts`),
  and links each note back to its anchored block in the Reader (`#/reader?work=&block=`). Shared
  `ui/Toast.tsx` shows transient,
  reduced-motion-aware status confirmations. `lookup/` is the view-only vocabulary lookup: selecting
  text exposes a "Look up" action on the `SelectionToolbar`; `LookupPanel.tsx` renders the enriched
  `DictionaryEntry` as a mature online-dictionary card — headword with pronunciations (and an audio
  control when available), color-coded part-of-speech sections (`partOfSpeechHue.tokens.ts` maps each part of
  speech to a tokenized, Day/Night hue class), numbered senses with italic examples and synonym chips,
  a quiet etymology line, and a sources footer — in a compact Radix popover anchored near the selection
  on desktop/tablet, and a content-height bottom `Sheet` on narrow screens (it scrolls for long
  entries), with explicit loading/empty/error states. Each work language fetches an ordered set of
  source tabs (`lookupSourcesForLanguage`), and `preferredTab` defaults to the first loaded-or-loading
  source in that order so the language's lead source stays the default — 萌典's Chinese definitions for
  Chinese (#272), offline WordNet for English — without trapping on a dead/empty source. `lookupApi.ts`
  calls `GET /api/lookup`. The reader passes the open work's language so Chinese selections lead with
  萌典, then zh.Wiktionary, then CC-CEDICT automatically. `externalDictionaries.ts` builds the header's
  "Open in" deep-links and is **language-aware** (#296/#302): an English headword gets the English
  learner dictionaries (Longman/Merriam-Webster/Oxford, #254/#303), a Chinese (CJK) headword gets the
  Chinese ones (汉典/萌典/ctext/国学大师) — `isEnglishHeadword` is the discriminator. Lookup never
  creates, pre-fills, or edits a note.
  `content/` is the focused Manage-content surface (`WorkContentPanel.tsx`), opened on demand inside
  the Library's "Manage content" `Sheet`: a work switcher, a header (title/author/type/language +
  unit/block counts via `workContentSummary.ts`), an "Open in Reader" deep-link, a calm add-content
  area (manual **paste-Markdown** editor only — bringing a file in is the Library **Add ▸ Upload file**
  action's job (#417); this panel edits an existing Work's content via `ingestMarkdown` — #418) reporting the ingestion result, and a units/blocks overview
  that summarizes reading units + block counts by default and reveals per-block type/plaintext rows
  behind an explicit **View blocks** toggle (#392); `contentApi.ts` calls the content/ingest endpoints.
  `diary/` is the Diary mode (#246 origin, #571 rich-Entry rework): `DiaryPage.tsx` renders the shared
  `capture/CaptureCard` at the top, wiring `onCaptured` to prepend the newly saved diary Entry into the
  browsable Timeline. `POST /api/diary/entries` returns a `DiaryEntryDto` (no proposal card — capture
  journals only). The Timeline shows the `kind === "diary"` filter over the derived result; each entry's
  durable body is a **ProseMirror/Tiptap document** displayed via its `bodyText` and **edited with the
  shared `RichContentEditor`** (`src/apps/web/src/shared/editor`, #570) — titles/dates/language/processing
  state stay structured metadata; `saveEdit` PATCHes the rich `bodyDoc` (guarding a blank body). Below
  capture, the **Timeline** history groups entries by day newest-first (pure `groupTimelineEntriesByDay`)
  with sticky date headers, lazy-loads older days as a sentinel scrolls into view (`IntersectionObserver`
  → next `before` page), and restores the learner's scroll position (and already-loaded pages) when they
  leave and return to Diary within the same app session (module-level `diarySessionStore.ts`, reset on a
  full reload); per-entry edit + delete and an explicit empty state. `diaryApi.ts` calls the
  `/api/diary/*` endpoints (`submitDiaryCapture` → `DiaryEntryDto`, `updateDiaryEntry(id, bodyDoc)`) and
  parses every response through `diaryContracts`. The "Mine my history" action and all Make Durable /
  proposal card UI are gone.
  `notesReview/` is the Notes-owned Review session (#657), replacing the retired `recall/` mode:
  `NotesReviewPage.tsx` reviews DUE note prompts ONE at a time and mounts at `/notes/review` (the
  canonical entry point); the legacy `/recall` route redirects (history-replace) onto it (#662), so legacy
  links recover into the same session. It is an explicit two-phase session driven by one discriminated `SessionState`
  (loading/error/empty/question/revealed/rated) so an empty or failed read can never masquerade as
  completion: phase 1 shows the prompt's cue + a single **Show note** affordance (no answer, no grades);
  after an explicit reveal it renders the note (a `legacy_custom` prompt's preserved answer, or a
  `current_note` prompt's live body — both via the shared `PmDocument`), moves focus to the Note region,
  and exposes the four self-ratings (Again/Hard/Good/Easy, also keys 1–4). Nothing advances automatically —
  after rating, the learner sees the next scheduled date and chooses **Review next**. A failed reveal keeps
  the question with a specific retry; a failed rating keeps the reveal and its grades in place with a
  retryable alert. `notesReviewApi.ts` calls `/api/notes/review/*` (`NoteReviewPromptDto`/`NoteRevealDto`)
  and parses via `noteReviewContracts`. Enrollment (#658) is surfaced from the note sheet, not this session:
  `notes/NoteReviewSection.tsx` (rendered by `NoteEditor.tsx` for a saved anchored note) loads the note's
  objective status and lets the learner add it to Review by confirming the exact anchor snapshot as a
  read-only Question; `notesReviewApi.ts` also exposes `fetchNoteReviewStatus`/`addNoteToReview` for it.
  The standalone `memory/` web mode (#573) was retired in #662: its browse/capture/manage clients
  (`MemoryPage`/`MemoryList`/`MemoryQuickAdd`/`MemoryAddDirection`/`MemoryNoteDetail`/`MemoryPromptRow`/
  `MemoryImport`), their tokens/labels, and `memoryApi.ts` are gone, and `/memory` now redirects to
  `/notes`. The retained capabilities live in Notes: the collection + search in `notes/NotesPage.tsx`,
  batch capture in `notes/NotesImport.tsx` (#661, `POST /api/notes/import`), and the offline-gloss
  suggestion via `notesApi.suggestGloss` → `GET /api/notes/suggest`. No live browser code calls
  `/api/memory/*` or `/api/recall/*`.
  `today/` is the deterministic routine board (#610) and the app's landing (`/`): `TodayPage.tsx` is a
  calm, finite, clearable single column (PRODUCT "v0 assistant home (Today)" + "The arranger") rendered
  from ONE server-composed read model — `todayApi.fetchTodayBoard` → `GET /api/today`, parsed once through
  `parseTodayBoardResponse`. It renders a **Due now** section with each deterministic routine as ONE
  grouped row — Recitation (count/overdue → `#/recitation`) and **Notes review** (count/overdue →
  `#/notes/review`), both actions read **Review** — ordered as the DTO gives (overdue-first, then
  `nextDueAt`, then Recitation as the stable tie-break, #639); a truthful **Done for today** state ONLY
  when `board.clear`, with the next known review date beneath it when `board.nextReviewAt` is set (omitted
  when nothing is enrolled ahead — never invented); a per-routine failure note with a Retry (a failed
  routine keeps the board un-clear — never a false clear); the compact save-first capture (`TodayCapture`
  wraps the shared `CaptureCard` — one **New diary entry** control that opens typed/voice capture only on
  activation, then collapses to an **Open in Diary** confirmation, #639); a first-run on-ramp to the
  Library when nothing is due or continuable; and a visibly-secondary **Continue** section of optional
  invitations (reading `#/reader?work=`, writing `#/write?work=`) that renders ONLY when a resumable item
  or a failed load exists — empty placeholders and the old diary-return link are gone (#638/#639). It
  handles loading and offline/retry, and refetches the whole board on window focus so returning from a
  deep-linked feature shows a freshly recomputed board. Pure routine-kind → title/action/path maps live in
  `today.tokens.ts` (coverage-excluded). The board persists no Today state; it is a pure read/compose over
  feature-owned canonical state.
  `authoredWorks/` is the owned-Work editor slice (#576): `AuthoredWorkPage.tsx` is the immersive
  `/write?work=<id>` surface that loads a user-authored Work's canonical ProseMirror document
  (`authoredWorkApi.fetchAuthoredWork`), edits it in the shared `RichContentEditor`, and reads it back
  through the same reader renderer (`reader/PmDocument`) with no format conversion — a missing/failed
  load falls back to a calm inline state. `useAutosave.ts` is a debounced (800ms), serialized,
  latest-write-safe autosave hook (5-state `idle|unsaved|saving|saved|error`; `saveAuthoredWorkContent`
  → `PUT /api/authored-works/:id/content`); `useUnsavedChangesWarning.ts` guards navigation while a save
  is pending. `authoredWork.tokens.ts` holds the pure status→label/class maps (coverage-excluded).
- Recitation direct Work-level maintenance (#577/#643): `src/apps/web/src/features/recitation/` — the
  learner declares a known Work retrievable and it enters FSRS maintenance directly; the passage/phase/
  chaining/fading/hub surface is retired (a repository-search guard, `retiredFlow.test.ts`, fails if any of
  its labels or modules reappear). `recitationApi.ts` (`enrollRecitation`/`listRecitationPlans`/
  `fetchRecitationReview`/`recordRecitationReview`, every response parsed through `recitationContracts`).
  `reciteOverviewApi.ts` (`fetchRecitationOverview` → `GET /api/recitation/overview`, parsed through
  `recitationContracts`). `RecitePage.tsx` is the `/recite` Recite home (a primary destination, #638):
  loading/error/ready states listing every enrolled Work newest-first with its due/next-review/paused
  status, a due-review lead when any Work is due (deep-linking `#/recitation`), and an empty state pointing
  to Library. `RecitationReviewCard.tsx` is ONE whole-Work review — recite the Work from memory, **Reveal** the
  canonical source (read live from the Work's blocks, never copied), then one of the four FSRS-mapped
  self-ratings; only the rating posts, and it reschedules only that Work's card. `RecitationReviewPage.tsx`
  is the `/recitation` route (reads `?work=<id>` to open THAT exact Work's review, else the earliest-due
  Work) with a "Back to Recite" control and loading/error/ready(review-or-calm Library recovery)/done
  (next-scheduled + Back to Today) states. The **"I can recite this"** entry points live on `library/AdminLibraryPage.tsx` (per un-enrolled
  Work; an enrolled Work shows a quiet "Reciting" status + a "Review" link) and `reader/ReadingHeader.tsx`
  (`ReciteThisControl` enrols then navigates to the review); both enrol BEFORE opening the review and are
  idempotent. Today's **Due now** Recitation row deep-links to `#/recitation`; the `/recite` route is now
  the Recite home (`app/AppRoutes.tsx`, #638 — no longer a Library redirect).
- Cross-feature UI lands in `src/shared/ui/`, client API helpers in `src/shared/api/` (created when
  first needed). Tests colocated `*.test.ts(x)`.

### `src/apps/desktop/` — Tauri desktop shell (Windows/macOS)

- Native desktop packaging (#446) around the shared web core — **Tauri v2, no Electron**. All shell
  logic is **Rust** under `src-tauri/src/` (kept out of the TS typecheck/lint/coverage gates); the
  window loads the **bundled** web `dist` (not a remote URL) via `frontendDist: "../../web/dist"`.
- `src-tauri/src/host_config.rs` builds the `platform="desktop"` + `apiBaseUrl` host runtime config
  (the #445 `@whetstone/contracts` contract) and the `initialization_script` string that sets
  `window.__WHETSTONE_HOST_CONFIG__` **before** the web app boots; a missing/empty base is injected
  verbatim so the web resolver shows its fail-loud startup screen. Base URL comes from
  `WHETSTONE_API_BASE_URL` (runtime env, then compile-time). `src-tauri/src/navigation.rs` decides
  which requests are external (http(s) to a non-app host) so `main.rs` opens them in the system
  browser via `tauri-plugin-opener` (called from Rust; no webview permission granted) — for both
  top-level `on_navigation` and `on_new_window` (`target="_blank"` / `window.open`, which Tauri routes
  separately; external → open + deny in-app window, internal → allow). Pure helpers
  (`is_external_navigation`, `classify_new_window`) are unit-tested with `cargo test --lib`.
- `src-tauri/capabilities/default.json` grants only `core:default` (no fs/shell/opener grants to the
  webview). Dev/package commands: `docs/QUICK_START.md § 7`. Rust build artifacts
  (`src-tauri/target/`, `src-tauri/gen/`) are git- and prettier-ignored.

### `src/apps/mobile/` — Capacitor iOS shell (macOS to build)

- Native iOS packaging (#447) around the shared web core — **Capacitor 8**. The app embeds the
  **bundled** web `dist` (`webDir: "../web/dist"` in `capacitor.config.ts`, not a remote URL) and keeps
  external links in Safari via `server.allowNavigation: []`.
- The only measured/typed source is `src/hostConfig.ts` (pure, 100%-covered): `iosHostConfig` builds
  the `platform="ios"` + `apiBaseUrl` host runtime config (the #445 `@whetstone/contracts` contract),
  `hostConfigInjectionScript` emits the `window.__WHETSTONE_HOST_CONFIG__ = {…}` JS, and
  `injectHostConfigScript` inserts it before `</head>` (fail-loud if absent). `src/iosPermissions.ts`
  (pure, 100%-covered) holds `ensureInfoPlistPermissions`, which idempotently adds the required
  `NSMicrophoneUsageDescription` (voice diary, AC #4) to the generated Info.plist. `scripts/` hold
  the sync-time I/O glue: `injectHostConfig.ts` (reads `WHETSTONE_API_BASE_URL`, fail-loud on
  missing/invalid, injects into the synced `ios/App/App/public/index.html`) and `applyIosPermissions.ts`
  (patches `ios/App/App/Info.plist`); both are wired into `add:ios`/`sync` so a clean checkout is
  TestFlight-ready with no manual edit.
- `capacitor.config.ts` and `scripts/` live outside `src/`, so they are not coverage-measured or in the
  TS gate; the generated native `ios/` project (created on macOS by `cap add ios`) is git-/prettier-/
  eslint-ignored. Build/run/TestFlight flow (macOS-only steps marked): `docs/QUICK_START.md § 8`. iOS
  native project generation, the `Info.plist` microphone permission, and TestFlight require macOS.

## Build, validate, run

- Workspace: pnpm + TypeScript project references. `pnpm install` then `pnpm build` before first use.
- Run/use walkthrough: `docs/QUICK_START.md` (install, env/data config, run server + web, first note flow).
- Setup (one command): `pnpm setup` (`scripts/setup.mjs`) — a declarative, extensible bootstrap. The runner (`scripts/setup/runner.mjs`) runs each step (`scripts/setup/steps/*.mjs`: toolchain check, install, build, Playwright Chromium, `.env` scaffold) through `check -> provision -> verify`, idempotent and fail-loud (each non-ok `StepResult` carries `what` + `remedy`). A **bare `pnpm setup` provisions ONLY the deterministic base** (no Ollama, no models, no heavy optional capability), so the default install is reproducible and offline-friendly (#602): `selectSteps` enables no optional capability unless asked. `pnpm setup:all` (`--all`) is the explicit one-command full install (base **plus every optional capability**: voice + ai + PDF, consent-gated); `pnpm setup:minimal` (`--minimal`) is an explicit base-only alias of the default; `pnpm setup:doctor` reports readiness without mutating. Single capabilities are (re)run on their own — `pnpm setup:voice`, `pnpm setup:ai`, `pnpm setup:pdf` — because `setup` is a built-in pnpm command, so passing a flag to a bare `pnpm setup` routes to the built-in and fails. The retired `pnpm setup:coach` (`--coach`) is recognized only to print the exact `pnpm setup:ai` migration and exit, never a silent no-op (#602). A raw flag/env combo (e.g. `--yes` to pre-consent installs) goes through the explicit `pnpm run setup -- --<flag>` escape hatch (`pnpm run setup -- --yes` = fully unattended). A system prerequisite is installed only through the consent seam `ctx.confirm` (`scripts/setup/confirm.mjs`; real stdin/tty wiring in `context.mjs`) via the reusable, consent-gated `installSystemTool` helper (`scripts/setup/installSystemTool.mjs`: check → package-manager detect → Y/N → install → on win32 refresh PATH from the registry and re-resolve so an install→use flow completes in one run, else name the stale-shell-PATH cause; instruct-only fallback on decline / no manager / non-interactive). The optional **voice** step (`scripts/setup/steps/voice.mjs`, `--voice`) installs faster-whisper + the bundled `whetstone-whisper` pip console-script wrapper (`scripts/setup/whisper-wrapper/`, emits the `docs/SPEECH.md` JSON contract), fetches the model, and writes `WHISPER_*` to `.env`; its Python 3 prerequisite is the first `installSystemTool` consumer (winget/brew after a Y, else instruct-only). The optional **ai** step (`scripts/setup/steps/ai.mjs`, `--ai`) is the second `installSystemTool` consumer and provisions the two optional local-only AI utilities (diary "tidy" + the Reader "AI 解释" gloss), off by default (#602): it installs Ollama (winget/brew/official-script after a Y, else instruct-only), pulls the diary-tidy (`llama3.1:8b`, override `DIARY_TIDY_MODEL`) + explain (`qwen2.5`, override `EXPLAIN_MODEL`) models, verifies each answers through the daemon, and writes `DIARY_TIDY_MODEL` + `EXPLAIN_MODEL` (never a key or cloud tier) to `.env`. The optional **pdf** step (`scripts/setup/steps/pdf.mjs`, `--pdf`) provisions the PDF-ingestion lane: it checks Python + the Docling pip package + OCRmyPDF + Tesseract, reporting each missing piece distinctly, installs Python (consent-gated) then `pip install docling`, and leaves the heavy OCRmyPDF/Tesseract system tools consent-gated (brew) or instruct-only (no clean install, e.g. Windows). The `.env` line read/upsert helpers are the shared owner `scripts/setup/env-file.mjs` (used by both voice and ai). Real I/O is confined to `scripts/setup/context.mjs`. Adding a runtime dependency = drop one step file here (GUIDELINES "Setup steps" gate).
- Dev (one command): `pnpm dev` (`scripts/dev.mjs`) builds the shared packages once, then runs the API server from source with reload (`tsx watch`) and the Vite web dev server together — route changes go live with no manual `build`. Production still runs the built `dist` via `pnpm --filter @whetstone/server start`.
- Gate: `pnpm validate` (= `typecheck && lint && test && build && smoke && e2e`); mirrors `.github/workflows/ci.yml`. `smoke` (`src/apps/web/dev-smoke.mjs`) boots the Vite dev server and checks every dependency resolves at serve time — catching dev-only breakage that `build` (rolldown) does not.
- Mutation testing (advisory, non-gating): `pnpm mutation` (Stryker, `stryker.conf.mjs`) plants mutants over `@whetstone/domain` + `@whetstone/contracts` to surface shallow tests that pass at 100% coverage — backing the GUIDELINES mutation-resistance rule. It uses a scoped `vitest.stryker.config.ts` (only those packages' tests) with the same `@whetstone/*` aliases, writes `reports/mutation/`, and runs nightly via `.github/workflows/mutation.yml` (uploads the report). Never part of `pnpm validate`; `break` unset so it can't fail a merge; `thresholds.low` is the advisory baseline. Extend the `mutate` globs to add a package later.
- Deploy (continuous, to a personal MacBook): `.github/workflows/deploy.yml` runs **only on push to `main`**, `runs-on: self-hosted`, gated on the `DEPLOY_ENABLED` repo variable (skips until set). It builds, then restarts a `launchd` app service that serves the single origin (web `dist` + `/api`) and migrates on boot; `DATABASE_DIR` persists across deploys; private HTTPS via Tailscale `serve` when `TAILSCALE_SERVE_ENABLED=true`. Setup runbook: `docs/DEPLOY.md`.
- E2E smoke (merge gate): `pnpm e2e` (`e2e/`, `@playwright/test`) boots the real stack — Fastify + in-memory PGlite + the Vite **dev** server (React dev mode) — seeded with a fixture EPUB and a small Markdown work, then drives the core reader loop in Chromium (open work → chapter; select in paragraph/blockquote/list → toolbar; add note → reload-persists; look up a word → definition). Every test fails on any console error, app-origin HTTP 4xx/5xx, or React hydration/DOM-nesting warning (`e2e/fixtures.ts`). Boot/seed harness: `e2e/stack.ts` + `e2e/globalSetup.ts`. CI installs Chromium (`playwright install --with-deps chromium`). Deterministic in-page visual probes for the tester (`e2e/probes.ts`: `contrast` / `geometry` / `contentPresent` + an `overlaps` helper, each self-contained for `page.evaluate`) and their integration spec (`e2e/tests/probes.spec.ts`, static `setContent` fixtures) let a visual `[Bug]` be filed on a computed value/rect instead of a screenshot.
- Screenshots (manual, outside the gate): `pnpm screenshots` (`scripts/screenshots.mjs`) boots the real stack on an ephemeral in-memory DB, ingests the public-domain `fixtures/epub/` files through the live pipeline, serves the production build via `vite preview`, and drives Playwright Chromium to write per-stage PNGs to `artifacts/screenshots/` (git-ignored): Today at the root route, Library at `#/library`, and the Reader — each across the Day/Night × desktop/mobile matrix — plus the selection → note-editor → note-saved annotation moment. `scripts/make-fixture-epub.mjs` regenerates the English fixture. Needs `pnpm exec playwright install chromium` once.
- Workflow roles: `.github/agents/*.agent.md` (design, developer, reviewer, tester). The **tester** (QA) is the exploratory bug-discovery layer above the E2E gate — `scripts/run-tester.cmd` / `run-tester-auto.cmd` + `scripts/tester-next-action.mjs` (queue-driven per-run filing budget); it boots the real stack on `main`, drives the app beyond the smoke, and files de-duplicated `[Bug]`s (read-only on code). Operational quick-reference: the
  `whetstone-engineering` skill in `.github/skills/`.
