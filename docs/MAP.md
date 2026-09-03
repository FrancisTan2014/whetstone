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
`DocumentValidationError`). Stable node ids use Tiptap UniqueID's server-side generator. `noteMaterial.ts`
(`projectNoteMaterial(json) -> canonical string`, `BlankNoteMaterialError`) is the pure, browser-safe
**exact-material projection** (#711): validates, then drops node ids + key order, NFC-normalizes text and
string attrs, collapses prose whitespace (code/opaque runs kept verbatim), ignores bold/italic while
keeping code + link marks/destinations, and preserves node type/order/structure and semantic attrs — so
two notes share a projection iff their material is semantically identical; no hashing here (that stays
server-side). The pure **near-material** trio (#713, read-only) sits alongside it: `nearMatch.ts`
(`projectNearMatch(json) -> NearMatchProjection | null`) gates eligibility (only doc/paragraph/text +
bold/italic; 2-40 ASCII English tokens; 8-240 code points; letter required) and derives a relaxed key
(NFKC + whitespace collapse + quote/apostrophe/dash fold + case fold) plus a `protectedEvidence`
multiset (numbers/symbols/negation/identifier-case) for vetoes; `nearMatchScore.ts` is the pinned
`damerau-levenshtein@1.0.8` adapter over code points (`score = 1 - distance / max(cpLen)`);
`nearMatchRanking.ts` (`selectNearMatches`, `NEAR_MATCH_THRESHOLD = 0.84`) excludes exact/case-only
pairs, vetoes on protected-evidence or lexical-guard mismatch, thresholds, and returns the top 5 by
score then id. Calibrated + gated by `fixtures/card-matching/near-v1.jsonl` (630 rows) via
`nearMatchCorpus.test.ts`; scale guarded by `nearMatchBenchmark.test.ts`. Tests
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
`nextReview.ts` (#676 the single pure projection of a card's next-due instant to the learner-facing
label — `formatNextReviewLabel({due, now, timeZone, shortTerm?})` → `Due now`/`Later today at <time>`/
`Tomorrow at <time>`/`<Month day, year> at <time>`, plus `isShortTermReviewState` + the
`SHORT_TERM_REVIEW_PREFIX`; resolved in the learner's zone over `localDay.ts` and every review surface
(Notes Review, note Review summaries/settings/sections, Recite, Recitation Review, Today) renders it, so
a same-day short-term interval reads as a local time, never a repeated date; throws on an invalid instant),
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
`createdAt`/`updatedAt`, `language`, `inputMode`, nullable `processingStatus`; the
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
`queued/transcribing/tidying/ready/failed`, the submit query validator, and the accepted/status DTOs;
#675 the status DTO carries a discriminated `failure: { code, retryable } | null` over four safe
categories `no_speech`/`voice_setup_required`/`transcription_failed`/`recording_missing`, with
`retryable` derived from the code via `makeVoiceCaptureFailure`/`isRetryableVoiceCaptureFailure` — raw
adapter/process error text never reaches the client),
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
- Single-owner database lifecycle (#805): a persistent `DATABASE_DIR` has exactly one process owner at
  a time. `src/db/databaseLifecycle.ts` (`openManagedDatabase`) canonicalizes the directory, acquires a
  cross-process lease FIRST, constructs PGlite only after, and releases the lease only after
  `pglite.close()` — so two embedded PostgreSQL runtimes can never mutate one WAL. In-memory needs no
  lease. `src/db/databaseLease.ts` (`createDatabaseLeaseAcquirer`, `DatabaseBusyError`) is the
  `proper-lockfile` heartbeat lock: a live owner is never displaced, a crashed owner's directory is
  reclaimed only after the stale window (never by touching the database). `index.ts` handles
  SIGINT/SIGTERM and startup failure through one idempotent shutdown (stop drains → close Fastify →
  close PGlite → release lease). Every entrypoint that opens the persistent store — `index.ts`,
  `mcp/main.ts`, and `data/backupCli.ts` — goes through this boundary, so a second start or a backup
  fails loudly before PGlite construction with a stop-the-running-app remedy. The real cross-process
  contract is proven by `src/db/databaseLease.crossProcess.test.ts` (isolated lane) via the
  coverage-excluded child harness `databaseLease.crossProcessWorker.ts`.
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
  shape: `memory_prompts.reveal_kind` ∈ {`legacy_custom`, `current_note`, `expected_response`}, enforced by the
  `memory_prompts_reveal_shape_ck` check (migrations `0054_notes_review_reveal.sql`, widened by
  `0056_last_rachel_grey.sql`, fail-loud). `legacy_custom`
  reveals the prompt's OWN preserved answer columns; `current_note` carries no answer columns and reveals the
  note's LIVE canonical `body_doc`/`body_text` (editing the note changes the reveal in place); `expected_response`
  stores an authored Success check in the `answer_doc`/`answer_text` columns and reveals it alongside the live
  note as Reference (#686). The pure
  `resolveNoteReveal` (`notesReviewReveal.ts`) switches on the discriminant; queries in `notesReviewQueries.ts`,
  the rating command reuses the shared review boundary (`rateReviewCard`) in `notesReviewCommands.ts`. All
  legacy write paths deposit `legacy_custom`; authored prompts over a saved note are minted by
  card authoring (#687, independent directions #688): `authorNoteCard.ts` (`authorNoteCard`, served at
  `POST /api/notes/review/author-cards` in `notesReviewRoutes.ts`, current-user scoped) authors ONE rich
  `current_note`/`expected_response` prompt + its `contains` link + ONE active shared card (retention 0.90,
  due now) over the learner's EXISTING note in place — never inserting or copying a note — plus one
  owner-scoped `card_creation_receipts` tombstone for retry-safety (shared with #689 via `cardCreationReceipt.ts`).
  A note may own MANY authored prompts, each independently scheduled (#688 dropped the
  one-authored-prompt-per-note unique index in migration `0061_gigantic_killraven.sql`), so a DISTINCT
  `submissionId` always creates a new card; per-submission idempotency is enforced by the creation receipt,
  not a note-uniqueness constraint. A Mark or bodyless note is rejected (`not_found`), a changed-payload
  replay of the same submission is `conflict` (409), and a deleted/card-removed target is `gone` (410).
- Notes home — the owner-scoped note surface (#659): the `notes` feature owns generic, owner-scoped CRUD +
  search for EVERY owned note (anchored, standalone, imported, or a Mark), independent of any work. Server:
  `noteRoutes.ts` serves `GET /api/notes` (one recency-ordered list — `updated_at` desc, entry-id tiebreak —
  with each note's rolled-up Review projection; `?work=<id>` narrows to that work's anchored notes and
  `?search=<q>` runs the note-centric search across body, anchor snapshot, prompt questions, and legacy
  answers), `GET|PATCH|DELETE /api/notes/:noteEntryId`, and `POST /api/notes` (creates a standalone
  `kind='note'`, `capture_source='manual'` note with no anchor). Queries live in `noteQueries.ts`
  (`listNotesForUser` recency/work/search + `summarizeNoteReview` per-note projection, `getNoteForOwner`,
  `searchNoteIds`, `listNoteReviewCards`, `findExactMaterialNotes` — owner-scoped exact-material match
  #711: projects the query doc, looks up `notes.material_fingerprint` (SHA-256 of the projection, indexed
  accelerator) then re-checks full-projection equality, `kind='note'` only, stable creation/id order, zero
  writes); owner-scoped writes in `noteCommands.ts` (`createStandaloneNote`/
  `updateNoteForOwner`/`deleteNoteForOwner`, each composing the single `insertNoteInTx`/`updateNoteBodyInTx`/
  `deleteNoteInTx` primitives — guarded by `noteFacetOwnership.test.ts`). Every note write stamps
  `notes.material_fingerprint` via `noteMaterialFingerprint.ts` (`fingerprintNoteMaterial(bodyDoc)` =
  SHA-256 of `projectNoteMaterial`; marks get `null`) — enforced by migration `0074`'s biconditional
  `notes_material_fingerprint_kind_ck` (added `NOT VALID`) + non-unique index; legacy note rows are filled
  once at startup by `noteMaterialFingerprintBackfill.ts` (`backfillNoteMaterialFingerprints`, one tx, then
  `VALIDATE CONSTRAINT`, no partial writes on abort). Every note write also stamps the read-only
  near-match key pair `notes.relaxed_key`/`relaxed_key_length` via `projectNearMatchKey`
  (`noteCommands.ts` `nearMatchColumns`; ineligible notes + marks get `null`/`null`) — enforced by
  migration `0076`'s biconditional check + a `relaxed_key_length` index; legacy rows filled once at
  startup by `noteNearMatchBackfill.ts` (`backfillNoteNearMatchKeys`). `noteNearMatchQuery.ts`
  (`findNearMatchNotes`, zero writes) length-bands the owner's eligible pool by `relaxed_key_length`,
  runs the pure `selectNearMatches` ranking, and returns high-precision near-duplicate candidates only
  (exact/case-only pairs and evidence/lexical-guard mismatches excluded). A saved note takes review cards
  through card authoring (`POST /api/notes/review/author-cards`, above) — one or MANY, each independently
  scheduled (#688) — not a separate enrollment step. Web: `NotesPage.tsx`
  is the single Notes home (one continuous list via `NotesHomeList.tsx`, per-row Review projection via
  `noteReviewSummaryLabel.ts`, debounced note-centric search, a "New card" primary action that composes a
  retrieval card in place — see #690). Opening any
  body-bearing note edits it in the one shared Note/Cards workspace `NoteWorkspace.tsx` (#700): Note mode
  hosts the `RichContentEditor`, and a header-overflow "Delete note" replaces the old inline delete; the
  origin-specific persistence adapters live in `noteWorkspaceModel.ts`. The owner-scoped client lives in `notes/notesApi.ts`
  (`fetchAllNotes({work,search})`/`createStandaloneNote`/`updateOwnedNote`/`deleteOwnedNote`) and
  `notesReview/notesReviewApi.ts` (`authorNoteCard`, the saved-note card client boundary).
- Notes-owned Review settings & history (#660): the same owner-scoped boundary manages each note prompt's
  Review lifecycle over the shared Review commands (never re-implementing FSRS). Server
  `notesReview/notesReviewSettings{Projection,Queries,Commands}.ts` project a per-prompt settings row
  (Question/grading-target content `revision` + reveal policy +
  `not_in_review`/`due`/`scheduled`/`paused` card state) and compose
  `reviewCardCommands` for edit-question/pause/resume/restart/remove/re-add; history is keyset-paginated
  (opaque cursor) over `review_events`. Routes (`notesReviewRoutes.ts`): `GET /api/notes/:noteEntryId/review/settings`,
  `GET /api/notes/review/prompts/:id/history`, `PATCH .../question`, `POST .../pause|/resume|/restart|/card`,
  `DELETE .../card`. Toggling an authored prompt's grading between `current_note` and `expected_response` is
  `setNoteGradingTarget` (`notesReviewSettingsCommands.ts`, served at `POST /api/notes/review/prompts/:id/grading-target`,
  `{ expectedRevision, mode: keep|restart, target }`): owner-scoped, `legacy_custom` is read-only (409), a
  blank Success check is rejected (400), and Question / grading-target writes compare-and-increment the
  loaded revision (`409 prompt_conflict` leaves the newer row untouched);
  `restart` composes the shared `applyResetToCardInTx` only after that compare succeeds (409 if cardless), all in one transaction (#686). Web: the workspace's **Cards** tab `CardsView.tsx` lists each prompt and drills into `CardDetail.tsx` (state-driven
  rich edit-question/pause/resume/restart/remove/re-add, overflow confirmations, no-double-submit, stale-action list reload)
  and a per-card `CardHistory.tsx` view; when the note carries a reflowable body its toolbar
  offers Add card → the inline `SavedNoteCardComposer.tsx` (card authoring, #687/#688 multiplicity). Its
  grading-target helpers (`sameGradingTarget`/`seedSuccessCheck`/failure messages) live in the shared
  `notes/gradingTarget.ts`, reused by the in-Review `RepairCardView.tsx` (#691). Client fns in
  `notesReview/notesReviewApi.ts` (`fetchNotePromptSettings`/`fetchNotePromptHistory`/`editNotePromptQuestion` (rich `questionDoc` + `expectedRevision`)/
  `pause|resume|restart|removeNotePromptCard`/`addNotePromptCardBack`/`authorNoteCard`).
- Retry-safe direct card creation (#689): `notesReview/createDirectCard.ts` (`createDirectCard`, served at
  `POST /api/notes/review/direct-cards` in `notesReviewRoutes.ts`, current-user scoped) turns an authored
  question/answer pair into exactly ONE manual standalone note + ONE `contains`-linked prompt (its reveal
  columns resolved through the shared `noteGradingColumns.resolveGradingColumns`, reused with #686) + ONE
  active shared card (retention 0.90, due now) + ONE owner-scoped `card_creation_receipts` row — all in one
  transaction, writing NO review event. Every readable text is derived server-side (`documentReadableText`/
  `documentText`); a blank question/answer/Success check is rejected (400 `invalid_question`/`invalid_answer`/
  `invalid_success_check`) before any write. Idempotency is keyed by `(user_id, submission_id)`: an
  `onConflictDoNothing` insert serializes concurrent/sequential retries, an identical replay returns the
  ORIGINAL result, a changed-payload replay is a `submission_conflict` (409), and a replay whose note was
  deleted is `submission_gone` (410) — the receipt is a non-resurrecting tombstone (plain-text ids, no FK, so
  it sits OUTSIDE `deleteNoteInTx`'s cascade). The note→prompt write reuses the single
  `noteCommands.insertNotePromptInTx` primitive (which `insertCurrentNotePromptInTx` also delegates to).
- Compose retrieval cards directly from Notes home (#690): `NotesPage.tsx`'s primary action is now
  "New card" (Import stays a 44px secondary), opening `notes/DirectCardComposer.tsx` — a wide `Sheet` that
  mints one `submissionId` (`crypto.randomUUID()`) up front, validates on Create, keeps the drafts + id on a
  failure so a retry replays the SAME submission, and on success announces "Card created. Due now." then
  focuses the new note's row (or offers "View card", which clears any active search/work filter via
  `useNavigate("/notes")` to reveal a note the filter excluded). The composer's body is the reusable
  `notes/RetrievalContractEditor.tsx` (the shared retrieval-contract editor: a workspace Answer↔Reference
  slot, a compact rich Question, a collapsible Success-check disclosure that relabels the workspace and, when
  non-empty, confirms before discard, plus an internal Try-preview that mirrors the Question→Reveal review
  sequence without persisting; exports the pure `gradingTargetFor`/`isDocumentBlank` and `SuccessCheckState`).
  The client boundary is `notesReview/notesReviewApi.ts`'s `createDirectCard` (raw `fetch`, mapping the #689
  server outcomes to a discriminated `CreateDirectCardError` — `conflict`/`gone`/`invalid`/`network`) against
  `POST /api/notes/review/direct-cards`; no new server or schema work (the #689 command is the whole backend).
- Review exact Note material before card creation (#712): a New-card save whose Answer already exists in Notes
  is authoritatively reviewed INSIDE the save transaction, never as a client-only warning. `notesReview/`
  server: `createDirectCard.ts` now takes a `pg_advisory_xact_lock` (`cardMaterialLock.acquireCardMaterialLock`
  from owner+answer-fingerprint keys) then reprojects and rechecks both exact and near matches
  (`exactMaterialQuery.queryMaterialMatches`, wrapping #711's `findExactMaterialNotes` and #713's
  `findNearMatchNotes`, returning `{ candidates, nearCandidates }`); on a hit it records an owner-scoped, expiring `card_creation_attempt`
  (`cardCreationAttemptStore.ts`: insert/get/refresh/consume/discard/`expireCardCreationAttempts`, binding the
  draft fingerprint + candidate-note fingerprint + revision) and returns the discriminated `needs_material_review`
  instead of creating. `reviewMaterialCommands.ts` resolves a parked attempt under the same lock+recheck:
  `useExistingMaterial` composes #688's `authorNoteCard` writer to add the drafted contract to a chosen existing
  note (→ `reused`), `keepSeparateMaterial` mints a distinct note via the #689 writer (→ `created`); a changed
  Answer, new/changed/deleted candidate, or expired/superseded/cross-owner attempt fails by name (refreshing the
  review when the evidence moved). `materialReviewCandidates.ts` builds each candidate's readable Answer excerpt +
  card count. Routes (`notesReviewRoutes.ts`): `POST /api/notes/review/material-matches` (advisory pre-save query),
  `.../material-review/use-existing`, `.../material-review/keep-separate`; startup `index.ts` calls
  `expireCardCreationAttempts`. Attempts are operational state (excluded from Entries/Timeline/Today/backup;
  migration `0075`). DTOs in `@whetstone/contracts` `noteReviewContracts.ts` (`directCardSaveResultDtoSchema`
  discriminated `created`|`reused`|`needs_material_review`, `materialReviewDtoSchema`/candidate, decision requests).
  Web: `notes/DirectCardComposer.tsx` owns the save→review→decision state machine (debounced 350ms advisory hint
  with monotonic cancellation, stacked `notes/MaterialReviewPanel.tsx` over the intact draft, Use-existing/Keep-separate/Back,
  created-vs-reused announcement in `NotesPage.tsx`);   `notesReview/notesReviewApi.ts` adds `fetchMaterialMatches`/`reuseExistingMaterial`/`keepSeparateMaterial` +
  `MaterialDecisionError`. E2E: `e2e/tests/notes-material-review.spec.ts`.
- Review near-duplicate Note material before card creation (#714): the SAME reviewed command + `card_creation_attempt`
  lifecycle (#712) also parks a review when the drafted Answer is a high-precision NEAR match (#713), surfaced as a
  SEPARATE "Possible duplicate" group — no new matcher, attempt table, writer, or mutation path. Disjoint by
  construction (the near matcher excludes exact/case-only). Domain: `document/nearMatchDifferences.ts`
  (`describeNearMatchDifferences`, pure word-level `{ before, after }` diff over two case-sensitive keys) +
  `NEAR_MATCH_EVIDENCE_VERSION` (`nearMatchRanking.ts`). Server: `noteNearMatchQuery.ts` carries each candidate's
  `caseSensitiveKey`; `materialReviewCandidates.loadNearMaterialReviewCandidates` adds server-computed `differences`;
  `cardCreationAttemptStore.fingerprintReviewCandidates` binds `{ exactNoteIds, nearNoteIds }` + the evidence version
  so any change in EITHER group refreshes review; `createDirectCard`/`reviewMaterialCommands` run both matchers, park on
  exact OR near, and accept a chosen note ∈ exact∪near. Contracts: `nearMaterialReviewCandidateDtoSchema` (+ `differences`),
  `materialReviewDtoSchema.nearCandidates`, `exactMaterialQueryResponseSchema.nearCandidates`. Web:
  `MaterialReviewPanel.tsx` renders the two groups separately ("Possible duplicate" + compare-the-meaning subtext + factual
  word differences, never a score); `DirectCardComposer.tsx` shows a near hint and a Retry on query failure;
  `notesReviewApi.fetchMaterialMatches` returns a discriminated `{ status, exact, near }`. E2E:
  `e2e/tests/notes-near-duplicate-review.spec.ts`.
- Preview corpus card drafts through a local MCP server (#717): `src/apps/server/src/mcp/` is the trusted local
  stdio Model-Context-Protocol surface. `mcpServer.ts` (`createMcpCardServer`) registers the corpus-card tools —
  `preview_card_creation` (#717) and `commit_card_creation` (#718, below), and no other (no save/schedule/edit/delete/
  search/bulk/file-scan tool) — as thin transports over the shared
  `notesReview/previewCardCreation.ts` (`previewCardCreation`) command; `mcp/main.ts` (coverage-excluded) is the
  process bootstrap (opens PGlite, migrates, sweeps expired attempts, builds the lexical service, connects a
  `StdioServerTransport`; stdout is reserved for JSON-RPC, logs go to stderr). Preview renders the SAME
  Question/Answer/Success-check + exact/near candidate evidence (+ optional WordNet sense-selected related
  material) as the HTTP "New card" path by reusing `prepareDirectCardDraft`, the exact/near matchers, and
  `materialReviewCandidates`, but WRITES NO learning state (no note/prompt/card/event/link/receipt): it only
  stages one opaque, 30-minute expiring `card_creation_attempt` (new `source='mcp'`, with a `draft_payload`
  snapshot; migration `0077`) and is idempotent by `requestId` (same payload → replay/refresh; changed payload →
  `changed_payload`). Input is validated once by the strict `mcpPreviewCardInputSchema` in `@whetstone/contracts`
  `mcpPreviewContracts.ts` (rejects batch/user-id/override/file-path/unknown keys as invalid params); the result
  is the discriminated `mcpPreviewCardResultSchema` (`previewed`|`invalid_*`|`changed_payload`). Run: `pnpm --filter
  @whetstone/server mcp` (after build). Usage: `docs/MCP.md`. Depends on `@modelcontextprotocol/sdk`.
- Commit an approved MCP preview through Notes (#718): `mcpServer.ts`'s second tool `commit_card_creation` consumes
  one approved `card_creation_attempt` (`source='mcp'`) by opaque `attemptId` plus one `decision` — `create`,
  `reuse` (reviewed Note id), or `keep_separate` — and accepts NO changed content (edits require a new preview).
  It is a thin transport + audit channel: the shared `notesReview/commitCardCreation.ts` (`commitCardCreation`)
  command reloads the owned attempt under the exact-fingerprint advisory lock (`acquireCardMaterialLock`), reruns
  authoritative matching, and — when the candidate set is unchanged — composes the SAME canonical writers as the
  HTTP path (`create`/`keep_separate` → #689 `createDirectCard`'s `writeDirectCardInTx`; `reuse` → #688
  `authorNoteCard`'s `writeAuthorNoteCardInTx`) for an unchanged Question/Answer/Success-check, 0.90 due-now card,
  zero-event transaction, and a `card_creation_receipts` row. New/changed/deleted candidates → refreshed preview +
  `needs_approval` (re-approval required). The receipt gains an immutable `channel` (`ui`|`mcp`, default `ui`) plus
  nullable `attempt_id` audit metadata (migration `0078`; the UI writers pass `channel='ui'`); reusing a Note never
  changes that Note's origin. Retry after success replays the original result via the receipt; a consumed attempt
  committed with a different decision kind → `decision_conflict`; forged/expired/foreign/changed attempts fail by
  name with zero writes. Wire contracts: `@whetstone/contracts` `mcpCommitContracts.ts` (strict
  `mcpCommitCardInputSchema`; discriminated `mcpCommitCardResultSchema` —
  `created`|`reused`|`kept_separate`|`needs_approval`|`not_found`|`expired`|`candidates_exist`|`not_a_candidate`|
  `no_material`|`decision_conflict`|`conflict`|`gone`). Usage: `docs/MCP.md`.
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
  cardless prompt's confirmed question read-only; the Cards-toolbar "Add card" opens `SavedNoteCardComposer.tsx`
  (card authoring, #687/#688) over any bodied note, adding one more independently-scheduled card.
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
- Local agent seam: `src/agent/` — the one provider-neutral boundary for a conversation with a locally
  installed agentic CLI (Qwen Code, Gemini CLI, Claude Code, Copilot CLI, …), #904. `agentSession.ts`
  (the port: `Agent.open({ instructions? })` → `AgentSession.send(prompt) -> { text }` / `close()`;
  transcript-first, `text` is the only required field), `cliAgent.ts` (the **provider-neutral adapter
  and stable boundary**: config is only `{ binaryPath, modelIdentifier }`; probes `--contract-version`,
  runs `--model <id> --output json [--session <id>]` per turn with the prompt on the child's **stdin**,
  validates the JSON response at the boundary, grants **no tools**), `fakeAgent.ts` (deterministic, for
  the agent-less `pnpm validate` gate), `agentProcess.ts` (the injected `spawn`-based process boundary
  that writes/closes stdin and bounds the run), `agentFailure.ts` (`AgentError` + the named codes a turn
  fails by), `agentConfig.ts` (env-driven, absent-config-safe `readAgentConfig` + `resolveAgent`:
  `AGENT_BINARY`+`AGENT_MODEL` together enable a provider, exactly one is an explicit config error,
  neither stays on the fake) and `agentHealth.ts` (`checkAgentHealth`: a failed probe is reported, never
  fatal). Not wired into any product flow yet; protocol in `docs/AGENT.md`.
- Voice input (STT) seam: `src/speech/` — `speechInput.ts` (the `SpeechInput`
  interface: `transcribe({ path }) -> { transcript, words[], language }`; transcript-first — `words` is
  optional timing evidence, empty when a provider has no aligner, #799), `fakeSpeechInput.ts`
  (deterministic, for the mic-less `pnpm validate` gate), `localSpeechInput.ts` (the **provider-neutral
  local adapter and stable boundary** (#799): config is only `{ binaryPath, modelIdentifier }`; builds
  the neutral protocol args `--model <id> --output json <audio>` (no forced language, no engine-specific
  flag), exposes the `--contract-version` readiness protocol, leniently validates transcript-first JSON
  at the boundary and maps to a `Transcription`; lazily auto-detects and dispatches to persistent mode,
  #884), `persistentSpeechManager.ts` (the **persistent local-process lifecycle manager**, #884: lazy
  start on first capture, kept warm across captures, killed outright after a fixed 5-minute sliding idle
  window (`IDLE_UNLOAD_MS`), crash mid-request fails cleanly and respawns transparently on the next
  capture), `whisperSpeechInput.ts` (the **legacy** OSS Whisper
  adapter kept working only as a migration fallback — builds the offline CLI args always with
  `--language auto` (#647); it does not implement the new protocol), `speechProcess.ts` (the injected,
  provider-neutral one-shot `execFile` runner shared by both adapters, plus the injected `spawn`-based
  persistent-process launcher `persistentSpeechManager.ts` drives) and `speechConfig.ts` (env-driven,
  absent-config-safe `readSpeechConfig` + `resolveSpeechInput`: the `LOCAL_ASR_BINARY`+`LOCAL_ASR_MODEL`
  pair is authoritative, a partial new pair is an explicit config error, the legacy
  `WHISPER_BINARY`+`WHISPER_MODEL_PATH` pair is a fallback only when neither new key is present, and a
  mixed config is flagged; stays on the fake until a provider is configured). `speechHealth.ts`
  (`checkSpeechHealth`, wired in `index.ts`) logs a boot warning when STT is on the fake, pointing at
  `pnpm setup:voice`, and a migration hint for the legacy/mixed states. Transcript shapes in
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
  (owner + `occurred_at`/`created_at`/`updated_at`), and the `diary_entries` row; **typed** capture accepts the
  canonical ProseMirror/Tiptap `body_doc` the learner authored in the shared editor (#678) — stored
  byte-for-byte, `input_mode` fixed to `typed` server-side, `body_text` derived via `documentReadableText`,
  `raw_transcript` null (no second copy) — and is ready immediately (`processing_status` null); voice is the
  async path (below, still `createTextDocument` from the transcript).
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
- Voice source audit (#801): a **ready voice** diary entry is auditable against its retained recording in
  the editor — migration `0080_voice_audio_content_type.sql` adds nullable `diary_entries.raw_audio_content_type`
  (persists the validated recorded container type; the rest of the data already lived on `diary_entries`).
  `DiaryEntryDto` gains `hasAudio` (`raw_audio_path != null`, path never leaked) + `transcript` (the verbatim
  `raw_transcript`); `TimelineDiaryEntryDto` gains `inputMode` so the editor mounts the audit row for a voice
  row without re-fetching typed rows. `diaryQueries.ts`: `getDiaryEntryForUser` (owner-scoped full-state DTO) +
  `getVoiceEntryAudio` (owner **and** voice-scoped → `{ audioPath, contentType }` from the stored path +
  `raw_audio_content_type`, else null). `diaryRoutes.ts` adds `GET /api/diary/entries/:id` (full-state, 404)
  and `GET /api/diary/entries/:id/audio` (streams the recording with `Accept-Ranges`/`Range`→206/416,
  `content-type` = the stored recorded container type re-validated through `parseRecordedAudioContentType`,
  falling back to the generic `audioContentType` octet-stream only when unrecognized; typed/unknown/other-
  user/missing-file → 404). `voiceCaptureAudioStore.ts` is the read boundary: pure `parseAudioRange` +
  `createVoiceCaptureAudioStore(root).open(path)` (resolves within the voice-capture root, stats, bounded
  stream) — an `audioStore` dep on the diary routes, built in `index.ts` (which also carries the env-gated
  E2E fixture speech). Web: `diaryApi.ts` `fetchDiaryEntry`/`diaryEntryAudioUrl`; `VoiceSourceRow.tsx` (a
  native `<audio controls>`, a collapsed read-only "Original transcript" `<details>`, the detected-language
  chip, and a truthful `Recording unavailable` state) mounted above the editor by `DiaryPage`'s `EditForm`
  for `inputMode === "voice"`.
- Async Tap-and-Talk voice capture: `src/features/diary/` (#565) — moves the durable boundary BEFORE
  speech-to-text (**save-first**). `voiceCaptureCommands.ts` (`submitVoiceCapture` saves the raw audio via
  the server file boundary, then in one transaction inserts the `entries` (`diary_entry`) + `personal_entries`
  - `diary_entries` rows with `input_mode="voice"`, server-owned owner/instants, `processing_status="queued"`,
    a placeholder empty body, and no fake transcript — persisted BEFORE any STT; `listActiveVoiceCaptures`/
    `getVoiceCaptureStatus`/`retryVoiceCapture`/`removeFailedVoiceCapture` are user-scoped → 404, retry only
    a `failed` capture → 409 otherwise, clearing the stored failure code; remove only a `failed` capture → 409
    otherwise, deleting its three Entry facets in a tx then best-effort unlinking the saved audio via the
    server file boundary). `voiceCaptureWorker.ts` (`processNextVoiceCapture` atomically claims
    the oldest `queued` row → `transcribing` → `tidying`, transcribes via the STT seam, tidies, then commits
    `ready` — building `body_doc`/`body_text`/`tidied_text` from the tidied text via `@whetstone/document`;
    **no proposal generation**; a throw/empty transcript/missing audio → `failed` with a stable failure code
    stored in `failure_reason` and audio kept — the code is chosen by category, never a raw error string: a
    transcribe throw logs the raw message server-side then stores `transcription_failed`, an empty transcript
    splits on whether local speech is configured (`speechFailure.ts` `classifyEmptyTranscript` →
    `no_speech`/`voice_setup_required`), missing audio → `recording_missing`; `requeueStalledVoiceCaptures`
    resets in-flight `transcribing`/`tidying` rows to `queued` at startup). `voiceCaptureFailure.ts`
    (`resolveVoiceCaptureFailure` maps a stored code — or a legacy/raw `failure_reason` — to the client
    `failure` DTO at read time, no migration). `diaryRoutes.ts` adds `POST /api/diary/voice-captures`,
    `GET /api/diary/voice-captures/:id`, `POST /api/diary/voice-captures/:id/retry`,
    `DELETE /api/diary/voice-captures/:id`, and `GET /api/diary/voice-captures` (`listActiveVoiceCaptures`
    — the user's diary captures with `processing_status IS NOT NULL AND != "ready"`, oldest-first — so the
    client can rebuild its pending/failed rows, #566). The Timeline query hides in-flight/failed captures
    (only `processing_status IS NULL OR = "ready"` surface). Wired in `index.ts`: `saveVoiceCaptureAudio`
    durable boundary + a `setInterval` drain loop over `processNextVoiceCapture`, `requeueStalledVoiceCaptures`
    at startup. Contracts in `voiceCaptureContracts.ts`.
- Config: `src/config/serverConfig.ts`.
- Data: `src/db/` — `schema.ts` (Drizzle), `dbClient.ts`, `migrate.ts`, `migrations/`. Tables include
  `entries` (the addressable-id spine; `type` ∈ work/reading_unit/block/note/toc_entry/**diary_entry**/**recitation_plan**/**recitation_passage** —
  `timeline_entry` retired, #571), works/authors (`work_meta.origin` — a required
  `imported`|`manual`|`authored` discriminator (#695) recording how a Work entered the Library, the
  authority for whether the Writing path owns it), `reading_units`, mdast `blocks` + PM `doc_blocks`,
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
    source is a no-op. Editable Works are a SEPARATE, canonical path: `content/editableWorkContent.ts` is
    the feature-neutral shared boundary that initializes (one `reading_units` row + one empty id-stamped PM
    paragraph, with `entries` + `contains` links) and reconciles (stable-id update/insert/remove of PM
    `doc_blocks`) editable-Work content in the caller's transaction. It takes an already-authorized
    Work/unit context and never decides origin/ownership. Its reconcile retains a removed block's `entries`
    row whenever durable history still references it — a note anchor (start/end), a Recitation passage range
    endpoint, a saved reading position, a review card or event, or a durable `entry_links` relation — and
    only deletes a genuinely unreferenced Entry after detaching its nullable provenance (harvested chunks,
    `derived_from` links), so cleanup never resets a schedule or drops learner-owned material. The
    authored-Writing commands (`authoredWorks/authoredWorkCommands.ts`) own auth/origin/owner and delegate
    their block writes here; #720 manual Library editing will adopt the same boundary with no migration or
    second block writer. PDF uploads are ingested only through the structured `/api/pdf-imports` lane below (canonical `doc_blocks`, never Markdown/mdast); the legacy Docling→Markdown route (`POST …/content/pdf`), its converter (`src/files/pdfToMarkdown.ts`), and the isolated `src/files/pdf_to_markdown.py` worker were removed (#783). The shared OCRmyPDF/Tesseract seam is preserved for the live OCR adapter: the single OCRmyPDF spawn boundary lives in `pdfOcr.ts` (`runOcrmypdf`, a raw `OcrmypdfRunResult` each caller classifies itself), with missing-toolchain classification (`PdfToolchainMissingError`, `classifyOcrError`) in `src/files/pdfToolchain.ts`. **Bounded PDF OCR adapter (#755, capability only — not yet wired to any route; first consumer #745):** `src/apps/server/src/files/pdfOcrAdapter.ts` executes ONE validated OCRmyPDF pre-pass over a server-staged source (`StagedFileHandle`) given #704's routing decision + resolved language: it re-probes the immutable source through #744's probe, refuses stale/mismatched routing (re-derives via `classifyOcrRouting`), OCRs only the freshly-classified text-less pages (one CPU job, `--skip-text`, no PDF/A/deskew/lossy recompression), re-probes and applies #704's geometry/native-text validators, then transfers a caller-owned validated output stage — reporting the pinned engine/version/language fingerprint (`PINNED_OCRMYPDF_VERSION`/`PINNED_TESSERACT_VERSION` in the adapter) — or a named `pdfOcrErrors.ts` `PdfOcrFailure` (tool/language missing, unsupported input, routing mismatch, timeout, memory, child crash, cancellation, geometry, native-text, output-validation, cleanup). Real / deterministic-fixture / unavailable adapters share one contract suite; the fixture needs no OCR tools or network. It owns no job/DB/publication state and never mutates the original. **Scanned/mixed OCR as a durable import phase (#745 English; #746 Chinese + pre-import override):** the #721 runner drives that adapter as an OCR phase before #701 structured conversion — `pdfImportRunner.ts` (`resolveConversionSource`) reads the attempt's resolved `ocr_language` (frozen at begin from the Work language + an optional pre-import override, both drawn from the three Work languages), routes via `classifyOcrRouting` (domain), and for a document with text-less pages runs OCR in that language, validates the output, then atomically adopts the derived `ocr.pdf` stage, recorded by the `phase`/`ocr_fingerprint` columns on `pdf_import_attempts` (the `ocr_language` column persists the chosen language and stamps block-evidence provenance) (recovery reruns the pre-pass while `ocr_fingerprint` is null and resumes structured ranges without re-OCR once it is set; one `removeStage` frees the original + derived stages). The composition root resolves the OCR backend through `pdfOcrRunnerResolution.ts` — the **real bounded adapter** on a platform that can enforce the memory ceiling, a **fail-visibly unavailable adapter** off it, or an **env-gated (`PDF_IMPORT_FIXTURE_OCR`) staged-bytes fixture transform** that flips the uploaded fixture's text-less pages to native and injects recovered text for dev/E2E — and OCR readiness (OCRmyPDF + Tesseract + the exact `eng`/`chi_sim`/`chi_tra` packs) is inspected at the process boundary by `pdfOcrToolchain.ts`. **Structured PDF adapter (#701, capability only — not yet wired to any route; first consumer #721):** `src/apps/server/src/files/pdfStructuredAdapter.ts` converts one server-staged born-digital PDF into a validated, versioned DoclingDocument-projection result (not Markdown) under explicit bounds — ≤128 MiB / ≤3000 pages, single-flight, per-range page windows concatenated in source order, OCR disabled, per-page native-text reported, memory/time ceilings, child terminated on every outcome. The pure StructuredDocument/RangeConversion contract + pins live in `@whetstone/contracts` (`pdfStructuredContracts.ts`); named failures in `src/files/pdfStructuredErrors.ts` (exit codes in LOCKSTEP with the worker); the isolated worker is `src/files/pdf_to_docling.py` (`--probe`/`--range`/`--check-memory-ceiling`, MIT, no OCR). The worker owns one fail-closed memory-boundary contract enforced by the platform's native controller — POSIX `RLIMIT_AS`, Windows an OS Job Object (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`/`JOB_OBJECT_LIMIT_JOB_MEMORY`/`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, nested inside any outer job, assigned before Docling/model construction) via pinned `pywin32==312`, with the boundary's `release` step standing KILL_ON_JOB_CLOSE down (handle kept open for `PeakJobMemoryUsed`; POSIX a no-op) from `main`'s `finally` on every exit path, because the job otherwise killed the worker at interpreter shutdown and overwrote every classified exit code with 0 (#843) — and `--check-memory-ceiling` is the cheap capability probe (a small fixed test ceiling, not the workload budget) setup and the #779 harness run to prove enforceability; a create/configure/assign failure returns the typed `memory_ceiling_unsupported` exit and converts nothing. Real adapter + deterministic fake share one contract suite (`createFakePdfStructuredAdapter` needs no Python; the real Docling lane skips cleanly). `pnpm setup:pdf` verifies the EXACT pinned docling/docling-core versions and the pinned model snapshot — and on Windows installs + pin-verifies `pywin32==312` and runs the capability probe — before reporting readiness. **Recoverable staged PDF imports (#721):** `src/apps/server/src/features/pdfImport/` runs that adapter resumably as an attempt state machine (start/status/cancel/retry are owner-scoped commands/queries; #702 adds the HTTP routes + publication). `pdfImportStage.ts` stages the uploaded bytes in a per-attempt dir under a server root (never a user path; it mints the `StagedFileHandle` the adapter reads and removes only that exact dir). `pdfImportStore.ts` persists attempts + per-range checkpoints in `pdf_import_attempts`/`pdf_import_ranges` with an atomic single-active claim (partial-unique index on the one `running` row), run-token fencing on every write, progress recomputed from committed ranges, and startup `running→interrupted` recovery. `pdfImportRunner.ts` (`processNextPdfImport`) claims→probes→converts each page range→checkpoints, resuming after the last committed range and stopping (`fenced`) the moment a cancel/interrupt fences a write. `pdfImportCommands.ts` owns start/cancel/retry (stage created before the row and rolled back on a bind failure; cancel aborts the owned child then frees the stage; retry re-queues an interrupted attempt) plus `retryPdfImportCleanup` — the owner-scoped path that re-removes a terminal attempt's leftover stage and clears the binding only on success, so a failed cleanup stays visible (`bound`) AND retryable — and `pdfImportQueries.ts` reports status as page/range COUNTS + typed failure. The pure state machine (states, `isTerminalAttemptState` cleanup-eligibility, `mayApplyRunOutput` fencing, `nextRangeIndex` resume) is `@whetstone/domain` `pdfImportAttempt.ts`; DTOs in `@whetstone/contracts` `pdfImportContracts.ts`. **Born-digital PDF publication (#702):** the same `pdfImport/` feature turns a converted attempt into ONE canonical Author→Work→ReadingUnit→Block Work stored ONLY as ProseMirror `doc_blocks` (never Markdown/mdast). `pdfCanonicalMapping.ts` is the pure mapper: it reconstructs the StructuredDocument from committed ranges (`concatenateRanges`) and projects each validated docling item to a canonical node (title/section_header→heading, text/caption→paragraph, list→bullet/ordered list, table→table, code/formula→codeBlock, footnote/reference→footnoteTarget, anything unmapped→explicit `unknown`), derives each heading's DEPTH from the PDF's own embedded bookmark outline rather than the docling label (#815 — real books emit `section_header` for every heading and `title` never, which flattened every table of contents to one level: `pdf_to_docling.py` reads the bookmark tree, the range/document contract carries it as an optional `outline`, and the pure `@whetstone/domain` `pdfOutlineHeadings.ts` matcher decides which bookmark names a heading — one bookmark names one heading, so a running head cannot duplicate the real one — with `HEADING_LEVEL_BY_LABEL` demoted to the last-resort fallback and the source of every level reported as `headingLevelSources`), splits the body into CHAPTER-scale ReadingUnits at the PDF's own top-level bookmarks — the authored navigation the EPUB spine already provides (#816: a unit starts at the FIRST heading resolved from a level-1 outline entry and is titled from that bookmark, so the real Clean Code lands on its publisher's 27 divisions instead of 525 per-heading fragments; with no top-level bookmark it falls back to the shallowest heading level present, joining a bare `Chapter 10`/`Appendix A` label to the heading that names it; a leading run still becomes one neutral **Start** unit) — the pure rule being `@whetstone/domain` `pdfReadingUnits.ts` (`decidePdfReadingUnits`), EXCLUDES page furniture before walking the body (#811) — docling emits running heads/feet inside `doc.body` (its own `doc.furniture` group is deprecated and empty, never read), so a top-level `page_header`/`page_footer` whose normalized text is empty, folio-shaped, repeated across ≥2 pages, or equal to a `title`/`section_header` anywhere in the document becomes NO block and is returned instead as `excludedFurniture` evidence (page, label, matched rule, normalized text) with item/character counts, while a unique candidate survives as a paragraph rather than the `unknown` fallback; the last two comparisons also run against a folio-stripped form of the text (#826 — one edge folio and its separator removed, so a `<chapter title> · <page>` running head, unique on every page, is still recognized); the rules are the pure `@whetstone/domain` `pdfPageFurniture.ts` (`decidePageFurniture`/`normalizePageFurnitureText`/`stripEmbeddedFolio`); a once-seen candidate whose folio-stripped text names an outline entry a REAL heading already claimed is ALSO excluded, on that evidence alone (`claimed-outline-entry`, applied by the caller — neither pure module knows of the other), while one naming an entry nothing has claimed yet is left for `resolveHeadingLevels`'s own claim-and-promote pass (which also retries a promotable candidate's folio-stripped text when its raw text does not match), so the outline is additional evidence layered onto #811's rules, never a stricter version of them (#828 — the residual one-block leak #826 left, measured on *Seven Concurrency Models in Seven Weeks* pp.40-62). Language-aware (#745), the mapper returns a typed **OCR outcome** with the affected page count and NO Work when pages still lack native text (`ocr_validation_failed`, a preflight/full-conversion disagreement or incomplete OCR — reported for any OCR language now that #746 enables Chinese and retires the former `ocr_language_not_enabled` build-time refusal), a typed **no-content** outcome — also NO Work — when the native-text pages map to zero canonical blocks, so publication never creates an empty-shell Work. Conversion COMPLETENESS is enforced at the worker's own trust boundary, never inferred from what a page produced: `pdf_to_docling.py` reads docling's `ConversionStatus` before building any payload and refuses a range that is not an unqualified `SUCCESS` — including one that reports no status at all, fail-closed (`ConversionIncomplete` → the `conversion_incomplete` exit code, in LOCKSTEP with `pdfStructuredErrors.ts`; `errors` are read only to describe the failure) — so a range docling silently truncated to the pages that survived is never committed and never published as a whole book (#832; judging completeness from per-page item counts was falsified by measurement and removed, see `docs/DECISIONS.md` D8). Picture/figure constructs are PRESERVED as canonical images (not refused): when the pinned worker can render a picture, `pdf_to_docling.py` writes it as a PNG artifact (temp-file + atomic rename) into a server-owned per-range dir inside the retained stage and emits only a strict manifest ref (relative path, `image/png`, sha256, byte length, pixel width/height — bytes never enter stdout/JSON/DB/logs), `pdfImportArtifacts.ts` (`adoptRangeArtifacts`) re-validates and adopts each ref (over-bound — >16 MiB single or >128 MiB per attempt — or unavailable falls back to #806's null-image `figure` placeholder; a path/hash/length/dimension/IO mismatch fails loudly as infra corruption), `pdfCanonicalMapping.ts` maps an adopted picture to a real `figure` carrying the artifact ref, and `pdfImportPublish.ts` stores the validated bytes through the content-addressed `imageResourceStore` (dedupe exactly like EPUB) and stamps the resulting `imageResourceId` onto the canonical image node the Reader serves (#806/#807). `pdfImportPublish.ts` (`beginPdfImport`/`publishConvertedPdfImport`) resolves metadata (entered → cleaned PDF metadata from the worker (#701 info-dict Title/Author) → filename stem → neutral default, never a raw path), then atomically commits Work metadata, the original uploaded PDF as immutable source provenance — the bytes are read back from the retained stage (#721) and persisted through the #706 source-file boundary, so `work_sources.file_path`/`sha256` are **non-null** and every published Work keeps its source bytes for provenance/export/re-ingestion while readable content stays in `doc_blocks` (the source file is provenance/export only) — the #706 exact-source claim (identical bytes reopen the owning Work), reading units, doc_blocks, additive per-block page/bbox/char-span/confidence + OCR engine/language evidence (`pdf_block_evidence`), and terminal publication state (`pdf_import_publications`); every bulk insert batches under the bind-parameter ceiling (`insertBatching.ts`) so a full-length document commits in one bounded transaction; the per-block evidence writer itself is the shared `pdfBlockEvidenceWriter.ts` so publication and re-map stamp evidence through one owner. **Offline re-map of a published Work (#861):** `pdfWorkRemap.ts` (`remapPublishedPdfWork`, driven by the covered `pdfWorkRemapCommandLine.ts` argv/report layer behind the `pnpm pdf:remap` bootstrap `pdfWorkRemapCli.ts`) rebuilds a published Work's reading units + canonical blocks from the ALREADY-RETAINED converted payload — `pdf_import_ranges` survives `removeRetainedStage`, which frees only the stage dir — by replaying the same `concatenateRanges`→`mapStructuredDocument` pair publication uses, so a mapper improvement lands on existing books WITHOUT the converter, the original PDF bytes, or Docling. It refuses (leaving the Work byte-identical) when `work_meta.manual_corrections_at` is set (a human's correction outranks an automated re-map; there is deliberately NO force override), when the attempt retains no ranges, or when mapping is not `mapped`; it fences the rewrite with the same `workContentRevision` compare-and-set the editor uses, reuses `content/editableWorkContent.replaceWorkContent` (which remaps reading positions proportionally and retains still-referenced block Entries), reports before/after unit + block counts, and never touches source bytes or import provenance. `pdfImportRoutes.ts` exposes `POST /api/pdf-imports` (start/dedup — raw bytes + base64 metadata header), `GET /api/pdf-imports/:id` (status + publication view), and `POST /api/pdf-imports/:id/{cancel,retry}`; the drain loop in `index.ts` now converts each attempt to the new `awaiting_review` state and stops there — since #750 publication no longer happens in the drain; a converted attempt is parked until the first status read routes it through the shared Work-creation duplicate-review boundary (`beginPdfReview`, above), which publishes it (or discards it) only under a serialized decision. The composition root builds the `PdfReviewPort` (`loadPdfReviewSource`/`publishConvertedPdfImport`/discard) the boundary uses so it never imports `pdfImport` internals; the composition root resolves the structured conversion backend through `pdfStructuredRunnerResolution.ts` — the **real #701 Docling runner** on a platform that can enforce the memory ceiling (self-reporting `tool_missing` per attempt when `pnpm setup:pdf`'s toolchain is absent), a **fail-visibly unavailable runner** on an unsupported platform — so a user upload is either converted from its own bytes or fails visibly, **never** published as canned content; an **env-gated (`PDF_IMPORT_FIXTURE_CONVERSION`) staged-fixture runner** for dev/E2E converts the ACTUAL staged bytes (a RangeConversion embedded after `STRUCTURED_PDF_FIXTURE_MARKER`), keeping the born-digital journey deterministic in CI without Python while staying input-derived, not canned. Reader surfacing generalized from a work-level `authored` gate to a unit-level `source_file === null` (`contentQueries.ts`), so PDF/manual doc_blocks render while EPUB units (non-null `source_file`) are unchanged. Web: `src/apps/web/src/features/pdfImport/` (`pdfImportApi.ts` upload/status/cancel, `pdfImportProgress.ts` state labels, `pdfImportPolling.ts` poll-until-terminal, `pdfImportSession.ts` resume-across-navigation) drives the Library upload/progress/cancel/reopen flow in `AdminLibraryPage.tsx`; an English scanned/mixed upload reports **Recognizing text** during the OCR phase, then shows a neutral **Checking your library for duplicates…** while the converted attempt is `awaiting_review` (#750) and either opens the Reader after atomic publication or transitions the polling into the SHARED `WorkCreationReviewPanel` when a credible duplicate is found (`describePdfImport` projects the minted review DTO into a `needs_review` terminal — no PDF-specific duplicate UI); the learner may choose the scanned-text OCR language before starting (the pre-import override), so English and both Chinese scripts all import and #746 retires the former `ocr_language_not_enabled` remedy (#745/#746). EPUB uploads (`epubCommands.ts`) create the Work from OPF metadata and are
  sha256-idempotent, persisting via `blockWriter.ts`. Uploaded-source identity is a shared boundary
  (`sourceClaims.ts`, `claimUploadedSource` + the `uploaded_source_claims` table, sha256 PK →
  owning Work): both the imported-EPUB front door and the imported-Markdown front door
  (`POST /api/works/epub` → `beginEpubCreation` (#748) and `POST /api/works/markdown` →
  `beginMarkdownCreation` (#747) — the shared duplicate-review boundary that
  reopens on exact bytes, commits the Work + source + blocks + claim in one transaction when no credible
  candidate exists, and otherwise parks a review attempt — see the workCreation entry below) resolve
  through it, so re-uploading identical bytes reopens the owning Work
  (200) instead of duplicating it; a concurrent loser rolls back and reopens the winner. The per-work
  content endpoint (`POST /api/works/:id/content`) and the PDF path are edit-existing, not mint, and do
  not claim (PDF dedup is #702's). Figure blocks have their transient image src
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
  overwritten). `commitImportedEpubWork` wires
  this into the real flow (composed by both the retained one-step `ingestEpub` front door — kept for
  the immediate-create path and adapter tests — and the #748 review boundary, which hands it the
  attempt's already-staged `.epub` to transfer in place): `resolveChapters` runs `htmlToDocument` per chapter, resolves each PM
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
  the remaining mdast `blocks` store is **imported-Markdown** debt — kept until Markdown ingestion also
  writes `doc_blocks` — NOT editable-Work history: editable Works are canonical PM `doc_blocks` from
  creation via `editableWorkContent.ts`, authored now and manual once #720 consumes that boundary);
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
  unchanged and the reader falls back to the flat unit list, #379). When a Markdown-pipeline work
  (`source_file IS NULL` units: manual/`.md`/PDF) has no authored `toc_entries`, `/structure` instead
  derives the `tableOfContents` at query time from the units' heading levels via the pure
  `domain/headingOutline.ts` `buildHeadingOutline` (first-block `heading` mdast `depth` → nested
  entries, each `targetUnitEntryId` = its own unit, no anchor; a headingless preface → a root "Start"
  entry; a chapter-scale PDF unit's OWN in-unit headings — #816's sections that stayed inside one
  chapter rather than becoming units of their own — nest under it too, each a `HeadingOutlineSection`
  carrying a `targetAnchor` (#865): `pdfCanonicalMapping.ts`'s `buildUnit` assigns every in-unit
  heading block (order > 0 within its unit) a deterministic, work-unique `sec-{page}-{charStart}` id —
  derived from the PDF's raw structured-document extraction, so it survives any mapper-only code
  change — and `contentQueries.ts`'s `loadInUnitHeadingsByUnit` reads those anchored heading
  `doc_blocks` back into the unit's `sections` before it reaches `buildHeadingOutline`, so both the
  unit's own heading and its in-unit sections nest through one shared stack and a continuous
  `orderIndex`). The sibling pure planner `domain/workRepartition.ts` `planSectionRepartition` partitions an
  edited block span at the same heading boundaries, preserving unit identity where a leading heading
  survives (the manual-save repartition, #698). Nothing is persisted, so re-ingestion recomputes with no stale entry; single-unit or
  headingless works yield no TOC (#680). `ReadingUnitDto`/`ReadingUnitStructureDto` also carry the
  derived `headingLevel?`. A block id is resolved over **both**
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
  deep-links to the right block (#312). Joined to work + author, ordered by reading order, a per-Work
  `row_number()` window caps each Work at `perWorkHitCap` (5) hits BEFORE the global `searchResultLimit`
  so no Work starves the page (#726), LIKE wildcards escaped; v0 is a substring scan, not ranked FTS
  (PRODUCT.md "v0 search"). Each hit ships a bounded snippet: SQL derives the first match's code-point
  position with the same case semantics (`strpos(lower(plaintext), lower(q))`) and the pure
  `buildSearchSnippet` (`@whetstone/domain`) windows ±220 code points of source plaintext around it with
  canonical UTF-16 match offsets and ellipsis flags (#726). The web `SearchPage` renders that snippet
  with a highlighted `<mark>` and clipped-end ellipses.
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
- Offline English lexical relationships (#715, read-only; exposed over HTTP by #772, the UI journey
  follows in #716): `src/apps/server/src/features/lexical/` resolves, for ONE eligible English
  word plus a caller-selected WordNet sense, the owner's single-word Notes connected by typed one-hop
  relations (inflection, synonym, antonym, derivation, direct hypernym, direct hyponym). The pure typing
  rules (surface eligibility, pointer-symbol classification, `sourceTarget` word indices, lemma-key
  normalization, relation priority/cap, direction/source facets) live in `@whetstone/domain`
  `lexicalRelations.ts`. `wordnetLexicalProvider.ts` is the read-only WordNet traversal over an injected
  seam (`createWordNetLexical` narrows the untrusted `wordpos` records and adds `seek(offset, pos)`):
  `collectLexicalSenses` lists every sense (never picking one), `resolveSenseRelations` walks exactly one
  hop from the selected sense (lexical antonym/derivation only from the selected word; semantic
  hyper/hyponym over the direct target synset — no grandparents/meronyms/multi-hop), and
  `classifyContextRelation` types one existing surface. `lexicalLemmatizer.ts` is the pinned
  `wink-lemmatizer` adapter (noun/verb/adjective; adverbs pass through). `lexicalNoteQuery.ts`
  (`findRelatedLexicalNotes`) is the owner-scoped query (kind=`note`, `personal_entries.user_id`,
  body-length narrowing, then reprojected + typed in JS), grouped in priority order and capped at 5 per
  relation; `lexicalRelationService.ts` orchestrates the `found | not_found | unsupported | unavailable`
  outcome union so a corrupt/missing WordNet DB never masquerades as "no relation". Writes nothing (no
  edge/sense/note/card/link/event). Calibrated + gated by `fixtures/card-matching/lexical-v1.jsonl`
  (323 rows) via `lexicalCorpus.test.ts` against the REAL bundled WordNet database; unit tests colocated.
- Related-material HTTP boundary (#772, foundation only — no React UI or browser journey; the
  **Find related material** disclosure and E2E land later in #716): exposes #715's read-only lexical
  service as owned Note evidence. Contracts in `contracts/relatedMaterialContracts.ts` (status-
  discriminated `found | not_found | unsupported | unavailable` senses/relations DTOs with stable sense
  identity/POS/definition/examples/lemmas and typed relation direction; the eligible surface is projected
  server-side, never trusted from the client). Server `src/apps/server/src/features/relatedMaterial/`:
  `relatedMaterialRoutes.ts` (`POST /api/notes/review/related-material/senses` and `/relations`, deps
  `{ db, service }`, wired in `http/createServer.ts` and instantiated in `index.ts` from the shared
  `WordPOS`) validates once at the contract boundary, delegates sense/relation policy to #715's
  `LexicalRelationService`, and maps outcomes to DTOs without auto-selecting a sense or reinterpreting a
  relation; `relatedMaterialQuery.ts` (`enrichRelatedMaterialGroups`) batches one owner-scoped
  `note_anchors` read to add each related note's capture context. Writes nothing on any path (no note,
  card, link, sense, relation, review state, or event).
- Related-material disclosure during New-card creation (#716, the browser UI + journey over #772's HTTP
  boundary): `src/apps/web/src/features/notes/`. `RelatedMaterialDisclosure.tsx` is the collapsed **Find
  related material** disclosure the composer mounts only for an eligible single-word Answer when no
  duplicate-review is active (`DirectCardComposer.tsx` gates on `normalizeLexicalSurface` and re-keys it by
  that surface, so a changed Answer resets it). Opening it triggers sense discovery; the learner explicitly
  selects a sense (never preselected) and inspects the typed related saved Notes ("same verb lemma",
  synonym, antonym, derived form, broader/narrower term). `relatedMaterialApi.ts` calls #772's senses/
  relations routes and maps any transport/non-2xx/drift to the retryable `unavailable` status;
  `relatedMaterial.tokens.ts` holds the pure relation->reason-label map. Related rows offer only **Open
  note** (opens in a new tab, preserving the draft); nothing here decides identity, preselects a card,
  enters Possible duplicate, alters the direct-card save, or persists a sense/relation. E2E
  `e2e/tests/notes-related-material.spec.ts`.
- Backup/restore (#600): `src/data/` owns verified whole-instance backup and restore. Pure, covered
  modules — `archive.ts` (versioned single-ZIP format: `manifest.json` + gzip database dump + per-root
  files, with SHA-256 checksums and `verifyArchive`), `dataRoots.ts` (durable file-root inventory from
  server config), `metadata.ts` (app + schema version), `fileTree.ts` (collect/write a root),
  `restoreSafety.ts` (rejects traversal/absolute/drive/backslash paths and unknown root names in the
  archive before any write), `backup.ts`
  and `restore.ts` (orchestrators with injectable I/O), and `cli.ts` (arg parse + output/error mapping).
  The thin, coverage-excluded `backupCli.ts`/`restoreCli.ts` wire real PGlite (`dumpDataDir`/`loadDataDir`)
  and fs for `pnpm data:backup -- --output <artifact>` / `pnpm data:restore -- --input <artifact>
--target <empty-dir>`. Backup refuses an in-memory `DATABASE_DIR` and an existing output, and opens
  the persistent store through the single-owner lifecycle boundary (#805, above) so it fails loudly if
  the running app already owns the directory; restore verifies before writing, refuses a non-empty
  target, runs migrations, and integrity-probes the restored database. Operator guide: `docs/BACKUP.md`.
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
  their due/next-review state (#638), Diary = `DiaryPage`, Write = `WriteRoute` at `/write` —
  `WritingHomePage` (the Writing home: **New essay** + the user's authored Works, most-recently-edited
  first, each with **Continue writing**/**Read**) when no `?work`, else the immersive `AuthoredWorkPage`
  editor for `?work=<id>` (#679); `/memory`
  redirects (history-replace) to `/notes` and `/recall` to `/notes/review` (#662 retired the standalone
  Memory/Recall pages — the redirects read live due/card state from the DB, never reset it); a trailing
  `path="*"` catch-all renders `NotFoundPage` so any unknown hash route — including the retired
  `#/practice` — resolves to the calm not-found page inside the shell); `AppShell.tsx` is the responsive
  frame (one `Primary` `<nav>` styled as a desktop sidebar / mobile bottom-bar, wrapped in `SafeArea`, plus
  the single `ToastViewport` live region). `navigation.ts` holds the **six** primary destinations — Today,
  Library, **Write** (`/write`), **Recite** (`/recite`), **Notes** (`/notes`), **Diary** (`/diary`)
  (#638, #679) — plus the pure `activeDestination(pathname)` mapping every secondary route to its owning
  parent so the parent tab stays truthfully active (Reader → Library, the `/write?work=` editor → Write,
  Recitation review → Recite, note Review + retired Memory/Recall → Notes); the destinations render as a
  **single non-wrapping row of ≥44px targets** on mobile
  (#390, #662, #638). **Search is a persistent shell utility** (a `Link` to `/search` in the top bar beside
  the `ThemeToggle`), not a primary destination. Reader, Review, and the Recitation review keep their routes
  but are NOT primary: Reader is a secondary surface under Library opened from context, the note Review is reached
  from Notes/Today, and the whole-Work Recitation review is reached from Recite (its "Back to Recite"
  control) or a contextual `?work=` deep link. Each secondary route's parent stays visibly active via
  `activeDestination` (e.g. `/reader` keeps Library active, `/write` keeps Write active, `/notes/review` keeps Notes active,
  `/recitation` keeps Recite active). The `ThemeToggle` is shell chrome in a slim top bar (never a tab, so it cannot
  wrap the mobile row). Every routed surface — including `/reader` and `/write` — is framed by the one shell
  (#638): the primary nav and Search utility stay present with the owning destination visibly active
  (Reader under Library; the `/write` editor under Write, #679), and each secondary surface additionally
  provides its own explicit back path (e.g. the reader's "Back to Library", the editor's "Writing").
  Routing is hash-based (origin-independent for file/Capacitor/Tauri); tests use
  `MemoryRouter`.
- Base UI primitives: `src/shared/ui/` — `SafeArea` (`100dvh`/`svh` + safe-area insets, never
  `100vh`), `PageFrame` (`PageFrame.tsx` + `PageFrame.tokens.ts`, #641: the one shared page-frame
  boundary owning horizontal gutters, the two content widths — `focused` 42rem / `collection` 64rem,
  viewport-capped — the header rhythm of an optional `ArrowLeft` parent link, one 28px/34px semibold
  H1, an optional muted description, and the single primary-action slot, plus the 24px header→content
  gap; every standard page frames through it while Reader stays the immersive exception), `Button`
  (token variants via `cva`; a `pending` prop shows a `Spinner`, sets `aria-busy`, and disables so an
  in-flight action cannot double-submit; `size="icon"` + the `IconButton` form give every icon-only
  control a 44×44 target, visible focus, a required accessible `label`, and a hover `title` from one
  boundary — #641), `Sheet` (Radix Dialog: focus trap +
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
  vars. Four global meaning channels only — indigo interaction/accent, blue links, amber annotations,
  red destructive — plus `--color-accent-selection` (a `color-mix` accent wash for active nav and
  selection that auto-adapts under `.dark`); the retired Vocabulary/Expression/Thought/Gem tokens are
  gone, leaving `anno-note`/`anno-mark` for Reader overlays (#641). General-purpose UI icons come from
  one system — `lucide-react` via direct named imports (tree-shaken), rendered 20px `strokeWidth={1.75}`
  in `currentColor` (16px in dense editor chrome); custom SVG is kept only for the functional `Spinner`
  and the product mark (#641). `src/shared/theme/` is the theme controller (`theme.ts` pure rules,
  `useTheme.ts` applies the `.dark` class + persists, `ThemeToggle.tsx` the sun/moon `IconButton`
  placed as app-shell chrome in a slim top bar — not a nav tab (#390)); `src/shared/motion/motion.tokens.ts` holds the motion tokens and `motion.ts`
  the `withReducedMotion` guard (behavior). The legacy `styles.css` is kept until screens migrate to tokens.
- Shared editing: `src/shared/editor/` is the cross-feature rich-content boundary (#570).
  `RichContentEditor.tsx` mounts the single `@whetstone/document` extension set through Tiptap React,
  exposes compact/full/workspace presentations over one live document (a chrome-free surface — no
  permanent toolbar), and emits validated detached JSON on change/save; the presentation body sizes live
  in `styles/theme.css` (`compact` = 6rem quick-input, `full` = 16rem page, `workspace` = a
  composition-sized `clamp` band reusing the compact surface, #677 — used by both note editors);
  `editorDocument.ts` owns empty-document
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
  live on the slash menu, gutter, and keyboard, not a toolbar. The PDF extraction-evidence seam (#763)
  is the editor's one optional guidance layer: `extractionEvidenceDecoration.ts` is the inert-by-default
  ProseMirror extension (`setExtractionEvidence(editor, map)`) that cues each uncorrected review-suggested
  block by its stable id, `ExtractionEvidenceControl.tsx` is the keyboard **Review extraction** disclosure
  (page, raw label, confidence band, OCR provenance; reframed once corrected), and `extractionEvidence.tokens.ts`
  holds the cue class + copy; `RichContentEditor.tsx` takes an optional `evidence?: ExtractionEvidenceMap`
  and surfaces both only for the caret's suggested block — every non-PDF surface threads nothing and stays
  inert. Persistence
  and autosave policy stay with consuming features.
- Features: `src/features/<feature>/` with page + `*Api.ts` (current: `library/`, `content/`,
  `reader/`, `notes/`, `lookup/`, `search/`, `diary/`). `search/` is the Search mode: `SearchPage.tsx` is a query
  field whose `searchApi.searchLibrary` hits `GET /api/search`, rendering block-level hits that each
  deep-link the reader to the work/block (`#/reader?work=&block=`), with explicit empty/error states.
  `library/` is the shelf-first admin home: `AdminLibraryPage.tsx` shows works as cards
  grouped by author (`groupWorksByAuthor.ts`) with an "Add work" `Sheet` dialog, and a single
  **Upload** control — the one file front door — that accepts `.epub`/`.pdf`/`.md` and creates a new
  Work (#417). It routes by type via the shared `shared/files/fileType.ts` `detectUploadKind`
  (MIME type first, extension fallback): an EPUB posts its raw bytes to the #748 duplicate-review
  boundary (`libraryApi.beginEpubCreation`, OPF metadata authoritative) — creating the Work directly when
  there is no credible duplicate, or opening the shared review panel when there is — while a
  PDF/Markdown (no reliable metadata) opens the same **Add work** sheet pre-filled with the filename's
  title, then on submit creates the Work and ingests the held file into it via the content feature's
  `contentApi.ingestMarkdown` (PDF uploads use the structured `/api/pdf-imports` lane). The Library is **read-first** (#640): each card leads with one
  primary action — a reader link (`#/reader?work=<entryId>`, labelled **Continue** when the work has a
  saved reading position, else **Read** — armed by `libraryApi.fetchWorksWithReadingPosition` →
  `GET /api/reading-position/works` → the set of work ids with a position) — and folds the rest into one
  ≥44px overflow menu (`WorkOverflowMenu.tsx`, Radix `DropdownMenu`, `modal={false}`, accessible name
  `More actions for <title>`): **I can recite this** / **Open in Recite** (`#/recite`) → **View notes**
  (`#/notes?work=<entryId>`) → **Edit in Writing** (`#/write?work=`) for authored works else **Manage
  content** (emits `onManageContent`) → separator → **Delete work** (destructive). Recitation _status_
  never appears in Library — Recite owns it. The header's file-and-create controls collapse into one
  ≥44px **Add** menu (`LibraryAddMenu.tsx`): **Upload file** (`.epub, .pdf, .md`) and
  **Add work manually** — document creation now lives on the Write home (#679); class maps for both menus
  live in the coverage-excluded
  `libraryMenu.tokens.ts`. **Upload file** opens the same file front door as before — an EPUB routes
  through the #748 review boundary (direct create or the shared review panel), a PDF/Markdown opens the pre-filled **Add work** sheet. Submitting the **Add work** sheet with no upload routes the purely-manual entry through the SAME #749 review boundary (`beginManualCreation`): no credible candidate mints the owned Work and opens its manual editor, a credible one parks the shared review panel. The **Add work** sheet's
  author field is `AuthorSelectField.tsx` — a `downshift` create-or-select combobox over
  `libraryApi.searchAuthors` (`GET /api/authors?query=`) that reuses an existing author by default and
  only offers an explicit **Add** for a genuinely new name, so duplicates can't be created by accident
  (#694). All author identity is **server-owned and canonical**: the `clean_author_name`/`author_name_key`
  SQL functions (NFKC + whitespace-collapse + case-fold) back a partial unique index on `authors.name_key`,
  `library/authorResolver.ts` `resolveNamedAuthor` resolves every writer (manual create, Work create, EPUB
  ingest) to one row via `ON CONFLICT`, and `library/libraryQueries.ts` `searchAuthors` returns matches plus
  the exact-match id and cleaned query; the client never canonicalizes. Work titles have a parallel
  server-owned canonical key: the `work_title_key` SQL function (NFKC + Unicode lowercase + whitespace
  removal, punctuation/CJK/edition preserved) backs a **generated** non-unique `work_meta.title_key`
  column (PostgreSQL derives it from the title on every write, so no Work writer can desync it), and
  `library/workDuplicateCandidatesQueries.ts` `findWorkDuplicateCandidates` returns up to
  five credible existing-Work duplicate candidates for proposed manual/imported metadata — bounded
  complete pool by title-key length, authored Works excluded, scored by the pure
  `domain/workDuplicateCandidates.ts` (pinned Damerau-Levenshtein), factual evidence only, writes
  nothing (#724). **Durable creation-review attempt foundation (#725; now driven by #747's Markdown
  duplicate-review boundary — see below):** `features/workCreation/workCreationAttemptStore.ts`
  persists one owner-scoped `work_creation_attempts` row holding the proposed title/author/language/type,
  the source kind/hash, the reviewed duplicate-candidate evidence snapshot + its fingerprint (so changed
  evidence — not only a new candidate id — forces a fresh review), and an ordinary markdown/EPUB upload
  stage, until one serialized Keep-separate/Open-existing decision commits or discards it. It stores NO
  Work/ReadingUnit/Block/source-claim row and has no FK into content, so a restored operational dump
  creates no live Work/content. `revision` is a compare-and-set fence (`beginFinalizeAttempt` claims the
  single `finalizing` decision slot; `completeAttempt`, `updateAttemptReview` reject a stale/replayed
  revision); a partial-unique index enforces at most one active (`pending`/`finalizing`) attempt per
  owner; DB checks pin the state/source-kind sets, keep a stage only on an ordinary upload, and store the
  snapshot + fingerprint together. Cleanup is explicit and retryable — `cancelAttempt`/`expireAttempts`
  return the exact owned stage paths and `clearStagePath`/`detachStagePath` free them only after the
  filesystem removal succeeds, never by age. Ordinary upload stages live under the config
  `workCreationStageDir`, deliberately NOT a backed-up data root (`resolveDataRoots`). The pure state
  machine + evidence fingerprint are `@whetstone/domain` `workCreationAttempt.ts`; DTOs (attempt view
  exposes stage presence only, never a filesystem path) in `@whetstone/contracts`
    `workCreationContracts.ts`. **Work-creation duplicate-review boundary (#747 Markdown / #748 EPUB /
    #749 manual / #750 PDF, first consumers of #725/#724):** `features/workCreation/` turns the Markdown,
    EPUB, manual, and converted-PDF front doors into a
    server-owned review gate.
    `workCreationCommands.ts` is the orchestration core — `beginMarkdownCreation`/`beginEpubCreation` stage
    the upload on the
    #725 attempt and decide the outcome (exact uploaded bytes reopen the owning Work as `exact_existing`
    with no attempt; new bytes with no credible candidate commit atomically as `created`; new bytes with
    credible #724 candidates persist ONE attempt (staged bytes + snapshot) as `needs_review`; empty content
    is `empty_content` / an unreadable archive is `invalid_epub`; candidate-query/storage uncertainty is
    `uncertain`, never a fake "no candidates"),
    and `openExistingWork`/`keepSeparateWork`/`cancelWorkCreation` are the revision-fenced, owner-scoped
    decisions (Open existing rechecks the chosen Work then completes, changing no Work; Keep separate
    rechecks exact identity + candidates — a changed snapshot re-reviews — then commits the
    Work/source/claim/content, dispatching by the attempt's `source_kind` to the Markdown or EPUB commit and
    transferring the stage exactly once, or — for a `pdf` attempt (#750) — publishing the referenced
    converted PDF through the injected `PdfReviewPort` (`publishConvertedPdfImport`) with no stage of its own
    to move; Back cancels the attempt and cleans the
    stage). `markdownDuplicateReview.ts` is the pure-ish review layer (author resolution,
    `computeReviewCandidates` over #724, `buildReviewDto` — its fallback source filename takes the kind's
    extension, `.epub` for an EPUB); `getWorkCreationReview` reads a parked attempt
    into that DTO; `workCreationRoutes.ts` exposes `POST /api/works/markdown` and `POST /api/works/epub`
    (begin), the review GET, and
    the decision/cancel routes (the `epubContentType` body parser is registered in `createServer`).
    `beginManualCreation` (`POST /api/works/manual`, #749) routes the manual **Add work** front door
    through this SAME gate: manual creation carries NO uploaded bytes, so the attempt stores metadata +
    reviewed candidates only (no #725 stage, `exact_existing` impossible by construction) — no credible
    candidate mints the owned empty-document Work immediately via `createWork` (origin `manual`), a
    credible one parks the shared review, and Keep separate commits the same byte-less way (no stage to
    transfer). This is the SOLE manual-commit path: the legacy `POST /api/works` (`libraryRoutes.ts`)
    now refuses `origin: "manual"` (`manual_requires_review`, #749) and only mints imported shells, so no
    client can commit an unreviewed manual Work around the boundary. The web
    review UI is `features/library/WorkCreationReviewPanel.tsx`
    (presentational "Possible duplicate" panel — proposal + factual candidate evidence + Open
    existing/Keep separate/Back), wired through `libraryApi.ts` (`beginMarkdownCreation`/`beginEpubCreation`/
    `beginManualCreation`/
    `fetchWorkCreationReview`/`openExistingWork`/`keepSeparateWork`/`cancelWorkCreation`) into
    `AdminLibraryPage.tsx`, which holds only the opaque attempt id + revision and preserves the
    draft/filename across review, Back, and retry (a manual `created` — from begin or Keep separate —
    opens the new Work's manual editor; imported/reopened land in Manage content). The
    begin/review/decision vocab +
    `parseWorkCreationReviewDto` live in `@whetstone/contracts` `workCreationReviewContracts.ts`.
    A converted PDF joins the SAME gate through `beginPdfReview` (#750): once #721 conversion/OCR reaches
    the new `awaiting_review` state, the first status read idempotently mints ONE `pdf`-kind review attempt
    referencing the `pdf_import_attempts` id (fenced single-active-per-PDF), loads the reconstructed
    document as the review source through the `PdfReviewPort`, and either publishes immediately (exact
    reopen / no credible candidate / typed refusal) or parks the shared review; publication only ever
    happens through a serialized decision — there is no auto-publish drain. The boundary
    still keeps `pdf_import_attempts` as the sole owner of the PDF stages — a `pdf` attempt only references that
  execution attempt. Creating a work auto-opens
  its Manage-content sheet (add content right after create); an EPUB import does not. Authored-document
  creation moved out of Library to the Write home (#679): the minimal title/type/language sheet now lives
  in `WritingHomePage` (**New essay**), which calls `authoredWorks/authoredWorkApi.createAuthoredWork`
  and hash-navigates into the editor (`#/write?work=<id>`). Works the current user authored carry an
  **Authored** badge in Library — derived from the Work's `origin` on the shared library projection
  (`fetchWorksWithReadingPosition`), not a separate `listAuthoredWorks` fetch (#695) — and use the same
  read-first primary action (Read/Continue → `#/reader`), with editing available as the overflow's
  **Edit in Writing** rather than competing on the card (#640). `reader/` is **目录-driven and lazy-loads one reading unit at a time** (no whole-book
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
  sidebar). When the structure carries a `tableOfContents` — authored EPUB nav (#379) or a Markdown
  work's heading-derived outline (#680) — it renders it as a **collapsible hierarchy** (#380) — indented by `depth` (as `data-depth`/`--toc-depth`),
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
  its control swatch, the shared `NoteWorkspace.tsx` (Note/Cards) is the create/edit surface hosted in the shared
  `Sheet`, `NoteList.tsx` renders notes as hued cards
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
  unit/block counts via `workContentSummary.ts`), an "Open in Reader" deep-link, and a units/blocks overview
  that summarizes reading units + block counts by default and reveals per-block type/plaintext rows
  behind an explicit **View blocks** toggle (#392); `contentApi.ts` calls the content/ingest endpoints.
  Imported Works still bring content in via the Library **Add ▸ Upload file** action (#417). Manual Works
  no longer paste Markdown here (#720 retired the legacy manual-Markdown ingestion; the server rejects
  `POST /api/works/:id/content` with `kind:"manual"` as `manual_markdown_unsupported`) — this panel is
  inspection-only for them and their content is authored in the dedicated manual editor below.
  `ManualWorkEditorPage.tsx` (#720, sections #697) is the owner-only manual-Work editor at
  `/library/works/:id/edit`, reached from the Library shelf's **Edit content** action on a manual Work
  (`WorkOverflowMenu` routes manual origins there; a **correctable** imported Work → **Correct content**
  (#762, below), other imported → Manage content, authored → Writing). It is a thin loader over the shared,
  origin-neutral `workContentEditor.tsx` (`WorkContentEditor` + `WorkEditorApi`, extracted from the former
  inline editor), binding it to the owner-scoped `manualWorkApi` adapter. A
  manual Work is now **N ordered ReadingUnits (sections)**, each section's first block a heading; the page
  is a responsive workspace whose **live Outline** (`WorkOutline.tsx` `projectDraftOutline` over
  `domain/headingOutline.buildHeadingOutline`) projects the active section's DRAFT headings into the
  persisted sections so heading edits appear immediately (#698), replaced on save by the
  server-reconciled canonical Outline (`deriveWorkOutline` remains the persisted-only projection) — no
  stored TOC tree. Below the standard `PageFrame`, the editor is a Work-specific immersive frame (100%,
  max 88rem, centered) — the editing analogue of Reader (#791). A **populated** Outline is a sticky 14rem
  sidebar ≥80rem (1.5rem gap) and a 44px-toggle overlay drawer <80rem (20rem 48–79.999rem, full width
  <48rem; Escape/backdrop dismiss + focus restore); an **empty** Outline renders nothing and reserves no
  track — the parent shows a proper 44px **Add section after current** action above the canvas instead. It loads the section
  list (`manualWorkApi.fetchManualWork`),
  edits one section at a time in the shared `RichContentEditor` (`fetchManualWorkUnit`, `presentation="work"`:
  one bordered paper surface, focus-within ring, blank-margin press focuses the caret at doc end) with a
  **persistent** one-row sticky `shared/editor/EditorToolbar` (a single **Block style** menu — `blockStyleMenu.ts`
  Text/Heading 1-3/Quote/Code block — plus marks, lists, undo/redo as 44px controls; roving-tabindex, no-wrap
  horizontal scroll), navigates sections with save-before-switch and stale-revision conflict
  retention (`saveManualWorkContent(workEntryId, unitEntryId, document, revision)` → `PUT
  /api/manual-works/:id/units/:unitId/content`). Contextual **Add next section** / **Add subsection**
  actions send only the active `targetUnitEntryId`, relation, and revision
  (`addManualWorkSection` → `POST /api/manual-works/:id/units`); the server derives heading level and
  inserts after the target branch through `domain/headingOutline.planWorkSectionInsertion`, then focuses
  the new untitled heading. The revision is the
  Work-scoped `work_meta.content_revision` (a monotonic non-negative integer), claimed atomically by both
  save and add; `personal_entries.updatedAt` is owner chronology only, never the revision truth. On save the draft's
  ordered PM blocks are substituted into the Work's block stream and the affected span is
  **repartitioned at every heading** (`content/editableWorkContent.repartitionEditableWorkContent` over
  the pure `domain/workRepartition.planSectionRepartition`): a surviving leading heading keeps its
  ReadingUnit id, a new heading mints a unit, a removed boundary merges into the preceding unit, every
  block id is preserved, and anchored notes/positions follow their block to the new unit; the response's
  reconciled active unit lets the editor keep focus on the edited block (#698). Reader/search/notes
  read the same blocks — no projection or dual write — and `content/contentQueries.loadWorkStructure`
  derives each unit's heading level + title from its first `doc_block` so the Reader hierarchy matches the
  editor Outline. Server: `library/manualWorkContentQueries` (`loadManualWorkForEditing` +
  `loadManualWorkUnit`, deriving section outline from first blocks) + `manualWorkContentCommands`
  (`updateManualWorkContent` per unit + `addManualWorkSection` via the shared
  `content/editableWorkContent.insertEditableWorkSection` order-shifting writer) own the owner/origin guard; the stale-revision
  check is the origin-neutral `content/workContentRevision.claimWorkContentRevision` compare-and-set over
  `work_meta.content_revision` (#703 — a monotonic non-negative integer, also reused by imported-Work
  correction, #762), and a successful claim bumps the owner-only `personal_entries.updated_at` chronology in the
  same transaction (`ManualWorkDto.revision` is that integer, `updatedAt` the chronology, display-only);
  `manualWorkContracts.ts` (in `@whetstone/contracts`) holds the `ManualWorkDto` (with `sections`), the
  per-unit update request, and the section/unit DTOs.
  `ImportedWorkCorrectionPage.tsx` (#762) is the administrative counterpart at
  `/library/works/:id/correct`, reached from **Correct content** on a canonical imported Work (`imported`
  origin, fully `doc_blocks`, exposed by `WorkListItemDto.correctable` from the `listWorks` projection). It
  reuses the SAME shared `WorkContentEditor` (Outline, save/Ctrl+S, conflict/draft retention, contextual insertion,
  heading repartition) bound to `importedWorkApi.ts` against `/api/imported-works/:id{,/units/:unitId
  ,/units/:unitId/content,/units}`, plus an **Open in Reader** header action the manual editor omits.
  Correction never creates a personal Entry and never rewrites the immutable source: server
  `library/importedWorkContentQueries` (`correctableImportedWorkSql`, `findCorrectableImportedWork`,
  `loadImportedWorkForCorrection`, `loadImportedWorkUnit`) + `importedWorkContentCommands`
  (`correctImportedWorkContent`, `addImportedWorkSection`) reuse the same insertion planner/writer,
  correction repartition path, and origin-neutral `workContentRevision` fence, then stamp durable correction markers via `content/workCorrectionMarkers`
  (`work_meta.manual_corrections_at` set once on the first real change; `doc_blocks.corrected_at` on each
  inserted/changed block; a no-op save advances the revision but stamps nothing). A re-upload of the exact
  same source reopens through `content/sourceClaims.claimUploadedSource`'s `exact_existing` branch without
  restaging, so corrected blocks and markers are never overwritten. `importedWorkContracts.ts` (in
  `@whetstone/contracts`) holds the `ImportedWorkDto` (no owner chronology; `+correctedAt`), the unit DTO,
  and the correction/add requests. The correction page also fetches the Work's SAFE PDF extraction
  evidence (#763) via `pdfExtractionEvidenceApi.fetchPdfExtractionEvidence` (`GET
  /api/imported-works/:id/extraction-evidence`, 404/non-PDF → empty map), threads it into the shared
  editor's evidence seam, and refetches after each save (`onContentSaved`) so a just-corrected block's cue
  clears. Server: `library/pdfExtractionEvidenceQueries.ts` JOINs `pdf_block_evidence` (page/label/
  confidence/OCR) with `doc_blocks` (type/`corrected_at`) for the owning Work only, derives review
  suggestion via the shared `@whetstone/domain` `pdfExtractionReview.ts` policy (`classifyExtractionConfidence`,
  `isUnmappedBlockType`, `suggestsExtractionReview`; the SAME policy `pdfCanonicalMapping` publication tests
  assert), and projects the boundary DTOs in `contracts/pdfExtractionEvidenceContracts.ts` — never file
  paths, coordinates, or a page image.
  **PDF usability gate (#705):** the shared `@whetstone/domain` `pdfUsability.ts` is the pure,
  falsifiable rubric for the 95% supported-PDF claim — `classifyPdfUsability` labels one import
  `automatic-usable`/`correctable`/`unsupported`, `assessCorpusEligibility` fixes the deduplicated,
  in-bound denominator, and `summarizeCorpus` computes the class/reason histograms, the gate verdict
  (`PDF_USABILITY_GATE_RATIO`), timing percentiles, and peak memory. The reproducible harness
  `scripts/probes/pdfUsabilityHarness.mjs` (run under `tsx` after `pnpm build`) drives a private corpus
  root (`--corpus`/`WHETSTONE_PDF_CORPUS`, recursive, SHA-256 deduped, bounds-enforced) through the
  pinned worker + the SAME `pdfCanonicalMapping` mapper, applies that rubric, and emits an
  aggregate-only report (counts, ratios, tool fingerprints — never a file name, path, or extracted
  text); it skips cleanly without the built workspace or the Docling runtime. It runs on POSIX and
  Windows: it preflights the worker's `--check-memory-ceiling` capability probe, resolves the same
  platform-aware ceiling and the same worker timeout as production through the server-config owners
  (`resolveStructuredPdfMemoryMib` / `resolveStructuredPdfTimeoutMs`, no duplicated numbers — a gate run
  uses the production 600000 ms timeout, and a diagnostic `--timeout-ms` differing from it forces a
  non-gating `corpusGatePass: false`), copies each in-bound source into the run temp root (no POSIX symlink),
  and reports peak memory through the worker's Job Object metrics sidecar on Windows / RSS sampling on
  POSIX. Flipping the supported
  lane and rewriting PRODUCT/setup wording stay maintainer steps gated on a measured passing run (the
  legacy Docling→Markdown route was removed in #783).
  `scripts/probes/pdfReadingPreview.mjs` (#830) is the **qualitative** counterpart to that aggregate
  harness: same pinned worker and same `mapStructuredDocument`, but it renders one page range
  (`<book.pdf> <firstPage> <lastPage> [--json out.json]`, after `pnpm build`) as the block tree the
  learner would actually read, alongside every `excludedFurniture` decision (page, rule, label,
  normalized text). Use the harness to ask whether a corpus is broadly usable and this probe to ask
  what is on the page — it is how the #811/#826 furniture rules were judged and how #828's remaining
  leak was isolated. It prints extracted text, so keep its output out of issues and PRs.
  `diary/` is the Diary mode (#246 origin, #571 rich-Entry rework): `DiaryPage.tsx` renders the shared
  `capture/CaptureCard` at the top (in the **workspace** presentation, #678), wiring `onCaptured` to prepend
  the newly saved diary Entry into the browsable Timeline. `CaptureCard` composes typed capture in the
  shared `RichContentEditor` (#678): it keeps a stable seed doc as the editor's authoritative `document`
  and tracks live edits via `onChange`, posts the canonical `bodyDoc` on **Capture**, keeps the rich
  content on a failed save, and resets to a fresh empty document only after the server returns the entry;
  blank is judged by `documentReadableText`. Today's `TodayCapture` mounts the same card in the **compact**
  presentation. `POST /api/diary/entries` returns a `DiaryEntryDto` (no proposal card — capture
  journals only). The Timeline shows the `kind === "diary"` filter over the derived result; each entry's
  durable body is a **ProseMirror/Tiptap document** rendered on the timeline through the static
  `reader/PmDocument` renderer (#678, so heading/list/emphasis/link structure shows) and **edited with the
  shared `RichContentEditor`** (`src/apps/web/src/shared/editor`, #570) — `bodyText` is now search/preview
  only; titles/dates/language/processing state stay structured metadata; `saveEdit` PATCHes the rich
  `bodyDoc` (guarding a blank body). Below
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
  (loading/error/empty/question/revealed/rated/repairing) so an empty or failed read can never masquerade as
  completion: phase 1 shows the prompt's cue + a single **Show note** affordance (no answer, no grades);
  after an explicit reveal it renders the note (a `legacy_custom` prompt's preserved answer, or a
  `current_note` prompt's live body — both via the shared `PmDocument`), moves focus to the Note region,
  and exposes the four self-ratings (Again/Hard/Good/Easy, also keys 1–4). Nothing advances automatically —
  after rating, the learner sees the next scheduled date and chooses **Review next**. A failed reveal keeps
  the question with a specific retry; a failed rating keeps the reveal and its grades in place with a
  retryable alert. When a card reads as unclear, a **Fix card** action in either phase enters
  `RepairCardView.tsx` (the `repairing` step) to repair the Question or grading target WITHOUT rating (#691):
  it loads the prompt settings + live reveal, reuses the shared `notes/gradingTarget.ts` helpers and #686's
  Keep-schedule/Restart contract for a grading-target change, and appends NO review event — so the card stays
  due. A committed fix re-attempts the SAME prompt from a fresh Question phase with the clarified cue when the
  refreshed row is still an active due card; if a concurrent rating/pause/removal left it no-longer-due it
  reloads whatever is actually due next instead of resurrecting a stale card. Question/grading-target saves
  carry the revision loaded on entry, retain drafts and offer **Reload card** on `prompt_conflict`, and freeze
  the rich editor while Keep/Restart is pending so its target snapshot cannot go stale. Cancel/Escape
  restores the exact prior phase and focus to that phase's **Fix card** control. Editing the shared note body instead is a one-way **Open note** deep link to
  `/notes?open=<entryId>` (handled by `notes/NotesPage.tsx`, which opens that note's editor once on first
  load). `notesReviewApi.ts` calls `/api/notes/review/*` (`NoteReviewPromptDto`/`NoteRevealDto`)
  and parses via `noteReviewContracts`. A saved note's review cards are authored from the note sheet, not
  this session: the Cards-toolbar Add card (in the shared `NoteWorkspace.tsx` for any bodied note)
  opens `SavedNoteCardComposer.tsx` (#687/#688), which authors one more independently-scheduled card in place
  over the note; `notesReviewApi.ts` exposes `authorNoteCard` for it.
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
  `authoredWorks/` is the owned-Work Writing slice (#576, #679): `WritingHomePage.tsx` is the `/write`
  home (**New essay** creation via `createAuthoredWork` + the user's authored Works from `listAuthoredWorks`,
  most-recently-edited first, each with **Continue writing**/**Read**); `AuthoredWorkPage.tsx` is the immersive
  `/write?work=<id>` editor that loads a user-authored Work's canonical ProseMirror document
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
- Typecheck scope (#850): each package has **two** projects — `tsconfig.json` (the emitting build project:
  production sources only, so `dist/` never ships tests) and a sibling **`tsconfig.test.json`** (emits
  nothing, `include: ["src/**/*.ts"]`, `exclude: ["dist"]`, and carries the `node`/`vitest` types tests
  need). The root solution `tsconfig.json` references both, so `pnpm typecheck` (`tsc -b`) sees **every**
  file a package owns — a newly added test is covered automatically, with no test-file list to extend.
  `scripts/build/typecheckScope.test.mjs` is the standing guard: it expands the root solution and every
  referenced project through the TypeScript API and fails naming any `<app|package>/src/**/*.{ts,tsx}`
  file left unchecked. Keeping Node types out of the build projects is what still stops production
  `domain`/`document` code reaching `node:` APIs.
- Run/use walkthrough: `docs/QUICK_START.md` (install, env/data config, run server + web, first note flow).
- Setup (one command): `pnpm setup` (`scripts/setup.mjs`) — a declarative, extensible bootstrap. The runner (`scripts/setup/runner.mjs`) runs each step (`scripts/setup/steps/*.mjs`: toolchain check, install, build, Playwright Chromium, `.env` scaffold) through `check -> provision -> verify`, idempotent and fail-loud (each non-ok `StepResult` carries `what` + `remedy`). A **bare `pnpm setup` provisions ONLY the deterministic base** (no Ollama, no models, no heavy optional capability), so the default install is reproducible and offline-friendly (#602): `selectSteps` enables no optional capability unless asked. `pnpm setup:all` (`--all`) is the explicit one-command full install (base **plus every optional capability**: voice + ai + PDF, consent-gated); `pnpm setup:minimal` (`--minimal`) is an explicit base-only alias of the default; `pnpm setup:doctor` reports readiness without mutating. Single capabilities are (re)run on their own — `pnpm setup:voice`, `pnpm setup:ai`, `pnpm setup:pdf` — because `setup` is a built-in pnpm command, so passing a flag to a bare `pnpm setup` routes to the built-in and fails. The retired `pnpm setup:coach` (`--coach`) is recognized only to print the exact `pnpm setup:ai` migration and exit, never a silent no-op (#602). A raw flag/env combo (e.g. `--yes` to pre-consent installs) goes through the explicit `pnpm run setup -- --<flag>` escape hatch (`pnpm run setup -- --yes` = fully unattended). A system prerequisite is installed only through the consent seam `ctx.confirm` (`scripts/setup/confirm.mjs`; real stdin/tty wiring in `context.mjs`) via the reusable, consent-gated `installSystemTool` helper (`scripts/setup/installSystemTool.mjs`: check → package-manager detect → Y/N → install → on win32 refresh PATH from the registry and re-resolve so an install→use flow completes in one run, else name the stale-shell-PATH cause; instruct-only fallback on decline / no manager / non-interactive). The optional **voice** step (`scripts/setup/steps/voice.mjs`, `--voice`) provisions the **calibrated Qwen3-ASR-1.7B** provider — the default local voice (#800) — CPU-only into a Whetstone-owned **isolated Python venv** under the ignored `.data/voice/qwen-venv` (`python -m venv`; pins never touch global Python): it installs a verified CPU `torch`, `qwen-asr==0.0.6`, `av` (bundled-ffmpeg WebM decode), and the bundled `whetstone-qwen` pip console-script wrapper (`scripts/setup/qwen-wrapper/`, emits the `docs/SPEECH.md` #799 JSON contract), pre-fetches the model `Qwen/Qwen3-ASR-1.7B` @ rev `7278e1e…`, and records a `.whetstone-voice-runtime` marker so a mismatched/incomplete venv is **repaired** not trusted; a **resource preflight** (`ctx.resources`) requires 12 GiB free disk + 12 GiB available memory **before** any download/load and fails with the exact requirement (never a silent fallback); it then writes the provider-neutral `LOCAL_ASR_BINARY`+`LOCAL_ASR_MODEL` and **removes the legacy `WHISPER_*`** pair, and verifies via the `--contract-version` probe (exact match required; the probe also reports provider/revision/requirements) plus one real sample inference; its Python 3 prerequisite is the first `installSystemTool` consumer (winget/brew after a Y, else instruct-only). Provider-neutral accuracy is measured by `pnpm calibrate:voice` (`scripts/voice/calibrate.mjs` → `whetstone_qwen.calibrate` over a local `.data/voice/calibration/manifest.json`): aggregate Chinese CER / English WER + cold duration + peak RSS only, never printing private audio/reference/transcript. The optional **ai** step (`scripts/setup/steps/ai.mjs`, `--ai`) is the second `installSystemTool` consumer and provisions the two optional local-only AI utilities (diary "tidy" + the Reader "AI 解释" gloss), off by default (#602): it installs Ollama (winget/brew/official-script after a Y, else instruct-only), pulls the diary-tidy (`llama3.1:8b`, override `DIARY_TIDY_MODEL`) + explain (`qwen2.5`, override `EXPLAIN_MODEL`) models, verifies each answers through the daemon, and writes `DIARY_TIDY_MODEL` + `EXPLAIN_MODEL` (never a key or cloud tier) to `.env`. The optional **pdf** step (`scripts/setup/steps/pdf.mjs`, `--pdf`) provisions the PDF-ingestion lane: it checks Python + the Docling pip package + OCRmyPDF + Tesseract (and the exact `eng`/`chi_sim`/`chi_tra` Tesseract packs the English and Chinese OCR lanes need, #745/#746), reporting each missing piece distinctly, installs Python (consent-gated) then `pip install docling` **pinned to the exact docling/docling-core versions the structured adapter (#701) requires and pre-fetches the pinned Docling model snapshot** (readiness means the exact runtime + models are present locally), and leaves the heavy OCRmyPDF/Tesseract system tools consent-gated (brew) or instruct-only (no clean install, e.g. Windows). The `.env` line read/upsert helpers are the shared owner `scripts/setup/env-file.mjs` (used by both voice and ai). Real I/O is confined to `scripts/setup/context.mjs`. Adding a runtime dependency = drop one step file here (GUIDELINES "Setup steps" gate).
- Dev (one command): `pnpm dev` (`scripts/dev.mjs`) builds the shared packages once, then runs the API server from source with reload (`tsx watch`) and the Vite web dev server together — route changes go live with no manual `build`. Production still runs the built `dist` via `pnpm --filter @whetstone/server start`.
- Gate: `pnpm validate` (= `typecheck && lint && test && build && smoke && e2e`); mirrors `.github/workflows/ci.yml`. `smoke` (`src/apps/web/dev-smoke.mjs`) boots the Vite dev server and checks every dependency resolves at serve time — catching dev-only breakage that `build` (rolldown) does not.
- CI quality coverage sharding (#897): `.github/workflows/ci.yml` leaves typecheck/lint in `quality-lint`, runs four `quality-coverage` matrix shards through `pnpm test:quality:shard`, then downloads and merges their Vitest blob reports through `pnpm test:quality:merge` in the unchanged required `Quality (typecheck, lint, 100% coverage)` job. Per-shard thresholds are disabled only while collecting partial reports; the merge enforces the existing global 100% thresholds. The final job uses `if: always()` and fails when either upstream job fails so the required check cannot pass as skipped. Local `pnpm test:quality` and `pnpm validate` remain unsharded.
- Python worker tests (merge gate, #845): the born-digital PDF worker (`src/apps/server/src/files/pdf_to_docling.py`) is unit-tested by `src/apps/server/src/files/tests/test_pdf_to_docling.py`, run by **`pnpm test:python`** (= `node scripts/run-python-tests.mjs -m unittest discover -s src/apps/server/src/files/tests -v`; the launcher resolves the interpreter `python`→`python3` like every other Python entry point here — `scripts/probes/*.mjs`, `scripts/setup/steps/pdf.mjs` — so `pnpm validate`/`pnpm test` stay portable on `python3`-only hosts) and included in `pnpm validate` via `validate:isolated` (and in `pnpm test`); it is intentionally **not** in `validate:changed`, keeping that fast JS changed-scope gate Python-free (the required CI lane + full `pnpm validate` enforce it). CI runs the same suite as the **required** `Python worker tests` lane in `.github/workflows/ci.yml` (a Python-only job: `actions/setup-python` provides `python`, invoked directly — no Node/pnpm), whose name is registered in `scripts/delivery/workflow.mjs` `REQUIRED_MERGE_CHECK_NAMES` so the deterministic merge gate blocks on it. The suite mocks docling/torch (via `sys.modules`) and drives probe/convert/mapping through injected fakes, so it needs only the Python standard library — never the heavy docling/torch/pywin32 install; it is separate from the JS/Vitest coverage measurement. The Windows-only Job Object real-process test (`WindowsMemoryCeilingEnforcementTests`, `@unittest.skipUnless(sys.platform == "win32")`, #782/#843) is the **only** automated coverage of `_WindowsMemoryBoundary` — the component behind two of the worker's three real defects (#833/#836, #843/#844) — and it deliberately skips (never weakens its platform guard) on this Linux-only CI, with `-v` printing that skip and its count so the lane can never look green while silently covering nothing; **CI cannot see a regression in it today (#847)**, so a real Windows run (`pnpm validate` or `pnpm test:python` on a Windows dev machine) is required after touching `_WindowsMemoryBoundary`. A `windows-latest` CI lane to close this was designed and verified locally (Python 3.13.15: all 167 tests, including the 3 Windows-only ones, pass in under a second once the pinned `pywin32==312` from `scripts/setup/steps/pdf.mjs`'s `PYWIN32_PIN` is installed — no docling/torch needed there either) but is **blocked on tooling, not on engineering merit**: adding it requires pushing a `.github/workflows/` change, which needs the GitHub `workflow` OAuth scope the delivery credentials available at the time did not have. The ready-to-apply diff is tracked in #891 (`manual-gate`, excluded from the automated queue since it needs a human to supply that credential) for whoever next holds a `workflow`-scoped credential.
- Mutation testing (advisory, non-gating): `pnpm mutation` (Stryker, `stryker.conf.mjs`) plants mutants over `@whetstone/domain` + `@whetstone/contracts` to surface shallow tests that pass at 100% coverage — backing the GUIDELINES mutation-resistance rule. It uses a scoped `vitest.stryker.config.ts` (only those packages' tests) with the same `@whetstone/*` aliases, writes `reports/mutation/`, and runs nightly via `.github/workflows/mutation.yml` (uploads the report). Never part of `pnpm validate`; `break` unset so it can't fail a merge; `thresholds.low` is the advisory baseline. Extend the `mutate` globs to add a package later.
- Deploy (continuous, to a personal MacBook): `.github/workflows/deploy.yml` runs **only on push to `main`**, `runs-on: self-hosted`, gated on the `DEPLOY_ENABLED` repo variable (skips until set). It builds, then restarts a `launchd` app service that serves the single origin (web `dist` + `/api`) and migrates on boot; `DATABASE_DIR` persists across deploys; private HTTPS via Tailscale `serve` when `TAILSCALE_SERVE_ENABLED=true`. Setup runbook: `docs/DEPLOY.md`.
- E2E smoke (merge gate): `pnpm e2e` (`e2e/`, `@playwright/test`) boots the real stack — Fastify + in-memory PGlite + the Vite **dev** server (React dev mode) — seeded with a fixture EPUB and a small Markdown work, then drives the core reader loop in Chromium (open work → chapter; select in paragraph/blockquote/list → toolbar; add note → reload-persists; look up a word → definition). Every test fails on any console error, app-origin HTTP 4xx/5xx, or React hydration/DOM-nesting warning (`e2e/fixtures.ts`). Boot/seed harness: `e2e/stack.ts` + `e2e/globalSetup.ts`. CI installs Chromium (`playwright install --with-deps chromium`). Deterministic in-page visual probes for the tester (`e2e/probes.ts`: `contrast` / `geometry` / `contentPresent` + an `overlaps` helper, each self-contained for `page.evaluate`) and their integration spec (`e2e/tests/probes.spec.ts`, static `setContent` fixtures) let a visual `[Bug]` be filed on a computed value/rect instead of a screenshot.
- Screenshots (manual, outside the gate): `pnpm screenshots` (`scripts/screenshots.mjs`) boots the real stack on an ephemeral in-memory DB, ingests the public-domain `fixtures/epub/` files through the live pipeline, serves the production build via `vite preview`, and drives Playwright Chromium to write per-stage PNGs to `artifacts/screenshots/` (git-ignored): Today at the root route, Library at `#/library`, and the Reader — each across the Day/Night × desktop/mobile matrix — plus the selection → note-editor → note-saved annotation moment. `scripts/make-fixture-epub.mjs` regenerates the English fixture. Needs `pnpm exec playwright install chromium` once.
- Workflow roles: `.github/agents/*.agent.md` (one developer owns design through a merge-ready PR;
  tester remains independent read-only QA). The **tester** is the exploratory bug-discovery layer
  above the E2E gate — `scripts/run-tester.cmd` / `run-tester-auto.cmd` +
  `scripts/delivery/testerNextAction.mjs` (queue-driven per-run filing budget); it boots the real stack
  on `main`, drives the app beyond the smoke, and files de-duplicated `[Bug]`s. Operational quick-reference: the
  `whetstone-engineering` skill in `.github/skills/`.
- Delivery harness: operator entrypoints stay at `scripts/run-*.cmd`; every internal is under
  **`scripts/delivery/`** — `supervisor.mjs` (no-model polling loop), `workflow.mjs` (shared
  queue/check-state selectors + merge gate), `health.mjs` (`pnpm delivery:health`),
  `developerNextAction.mjs` / `testerNextAction.mjs` (per-role selectors), `pickNextIssue.mjs`
  (dependency-ready issue selection), `mergeReadyPrs.mjs` (deterministic exact-head CI merge), and
  `unblockReadyIssues.mjs` (dependency unblocking), plus their `*.test.mjs`. Launchers depend inward
  into `scripts/delivery/`, never back out. Workflow/supervisor source is held at 100% coverage by
  `pnpm test:workflow`.
