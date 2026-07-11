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
rendering; `blocksToMarkdown` reconstructs a whole work for export), `author.ts`, `work.ts`,
`noteTemplate.ts` (v0 note templates +
size-based preselection), `noteAnswers.ts` (answer validation + note-body Markdown), `noteAnchor.ts`
(anchors a note to a block id with an optional sub-block offset range), `productIdentity.ts`,
`diaryTimeline.ts` (#246 voice-diary pure date logic — `toDayKey`/`isDayKey`/`toMonthKey`, and
`monthBounds`/`shiftMonth`/`monthGrid` for the date-jump calendar; day-grouping now lives in `timeline.ts`),
`timeline.ts` (#571 the logical Timeline: the `diary`/`note`/`work`/`recitation` discriminated-kind
vocabulary, each kind
mapped to a real Entry type — there is no `timeline_entry`; the deterministic order `occurredAt` DESC with a
stable `entryId` ASC tie-break; and day-grouping/`timelineDays`/`groupTimelineEntriesByDay` so the Timeline
is a derived view, never a store), `recitation.ts` (#577 the learner-controlled recitation-plan phase
vocabulary `familiarizing`/`learning`/`maintenance` + `isRecitationPhase`), `recitationPassage.ts` (#578
the pure passage engine: `seedPassageRanges`/`splitPassageRange`/`mergePassageRanges` for boundary edits
over blocks, `coveredPassageText`, `reanchorPassageRange` (unchanged/relocated/needs_repair), the
`passageCueText` cue builder + `recitationRatingChoices`/`recitationCueStrengths`/`passageAnchorStatuses`
vocabulary), `recitationFading.ts` (#579 the pure render-time support-level projection:
`recitationSupportLevels` `full`/`reduced`/`first`/`hidden` + `projectRecitationSupport`/
`supportLevelShowsTarget`/`DEFAULT_RECITATION_SUPPORT_LEVEL`, masked runs carry a length only),
`recitationChaining.ts` (#580 the pure chaining/ownership engine: `isPassageOwned`/`computeOwnedPrefix`/
`isWholeWorkOwned`/`chainEligibility`/`resolveChainBoundary` over the contiguous owned prefix,
`selectRecitationTodayAction` bounded priority `due_passage`>`chain`>`whole_work`>`none`, and the
`SessionRecallOutcome` held/broke logic `passagesToFailFromOutcome`/`isOutcomePassageInSession`) and
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
`recitationContracts.ts` (#577 recitation routines: `recitationPhaseDtoSchema`, the adopt/set-phase
request schemas, `RecitationPlanDto`/list/continue DTOs; the Timeline union gains a `recitation` member
carrying the Work title + phase),
`recitationPassageContracts.ts` (#578 passage practice: `RecitationPassageDto`/list, the
`DueRecitationPassageDto` (context + cue material + `defaultCueStrength` + `anchorStatus` + `supportLevel`),
the split/merge/record-review request schemas (record-review carries the #580 `leadInFailed` flag), the
#579 `recitationSupportLevelDtoSchema` + set-support-level request/response schemas, and `parse*` boundary
helpers),
`recitationChainingContracts.ts` (#580 contiguous chaining + whole-work maintenance: `RecitationChainingDto`
(owned prefix, `chainEligibility` union, active chain, whole-work state), `RecitationChainDto`,
`SessionRecallOutcomeDto` held/broke union, `RecitationTodayDto`, the start-chain/complete-chain/
review-whole-work request schemas, and their `parse*` boundary helpers),
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
  (`noteCommands.ts`/`noteQueries.ts`); `reading_positions` is user-owned the same way; the Memory notes
  - (via the shared `personal_entries` facet, below) and `nudge_state` (the reading→practice nudge
    cooldown, below) are user-owned the same way; shared
    content tables stay unowned.
- Memory store (#595): `src/features/memory/` (`memoryCommands.ts` deposit/reviewChunk/pushedPhrase/
  recordReview/snooze, `memoryQueries.ts` due/search/get + by-chunk review-state grouping + ReviewState
  <->row mapping) over Entry-backed rows: a `memory_notes` note (a first-class owned Entry — ownership +
  chronology in the shared `personal_entries` facet; provenance to its source is a `derived_from`
  `entry_links` row, not a column) and one-or-more `memory_prompts` (each a child Entry linked by
  `contains`; `cue`/`answer` docs + text, a `lifecycle` of `draft` — captured but no revealable answer, so
  no card — or `scheduled` with inline FSRS columns + an optional `chunk_id` link to a practice chunk
  (#205)), with `memory_prompt_reviews` as the append-only history. A prompt is `scheduled` (and appears in
  the due queue) iff it has BOTH a non-blank cue AND answer; the offline dictionary may SUGGEST an answer
  but never blocks the write. Pure scheduling is `@whetstone/domain` FSRS (v6, via `ts-fsrs`, in `fsrs.ts`);
  DTOs/validation in `@whetstone/contracts` (`memoryContracts.ts`). The web Recall surface is served by
  `memoryRoutes.ts` (`registerMemoryReviewRoutes`, current-user scoped, Zod-validated): `GET /api/recall/due`
  (today's due scheduled prompts, capped at `DAILY_RECALL_CAP` = 20 so a backlog never becomes a wall),
  `POST /api/recall/prompts/:id/review` (`{ rating }` → FSRS advance + a `memory_prompt_reviews` row; 404
  otherwise), `POST /api/recall/prompts/:id/snooze` (the `snoozePrompt` command defers only `due_at` one day
  — not a rating; 404 otherwise); wired in `http/createServer.ts` (the `recall` dependency option).
- Diary capture (owned, journals only) (#571): `src/apps/server/src/features/diary/` is the single
  owned-capture surface — the retired `makeDurable/` feature (proposal generation, `timeline_entries`,
  `proposal_candidates`/`proposal_reviews`, history backfill, `makeDurableContracts.ts`, the domain
  `makeDurable.ts`) is gone; a diary capture **journals only** and never gates or slows on a proposal. The
  diary write path (`diaryCommands.ts`/`voiceCaptureCommands.ts`/`voiceCaptureWorker.ts`), the derived
  Timeline query (`diaryQueries.ts` over `personal_entries` + `diary_entries` + `notes`), and the web
  `CaptureCard`/`DiaryPage` are described in the "Diary" bullets below.
- Reading→practice nudge: `src/features/nudge/` (#245) surfaces ONE value-ranked, recency-decaying,
  cooldown-gated recent reading capture as a practice prompt. `nudgeQueries.ts`
  `listRecentReadingCaptures` reads `notes` + `note_anchors` (newest first, join to the source block's
  work for the title) and shapes each as the SAME deterministic harvest case/chunk ids
  (`harvestCaseId`/`harvestChunkId` = `harvest-<noteId>` / `harvest-chunk-<noteId>`, reused by
  `harvestReadingCase`). `nudgeCommands.ts` `selectReadingNudgeCapture` ranks the captures via the pure
  domain `rankReadingNudges`/`topReadingNudge` (`@whetstone/domain` `readingNudge.ts`, score = gap ×
  frequency + a bounded recency boost that halves every 7 days; reading captures use neutral frequency 1
  and a derived live mastery status) after excluding any chunk in cooldown, and is shared by BOTH the
  nudge endpoint and the practice lead so they propose the same case. `computeReadingNudge` returns the
  top as a `NudgeDto` (and records `last_surfaced_at`); `dismissReadingNudge` = cooldown (`dismissed_until`
  = now + `NUDGE_COOLDOWN_DAYS` = 3). The only persisted state is `nudge_state` (PK `(user_id, chunk_id)`,
  nullable `dismissed_until`/`last_surfaced_at`) — user-owned, ranking derived live each time. Routes
  (`nudgeRoutes.ts`, current-user scoped, Zod-validated, `now` injected): `GET /api/nudge` →
  `{ nudge: NudgeDto | null }`, `POST /api/nudge/:chunkId/dismiss` → 204; wired in `createServer.ts` /
  `index.ts`. DTO in `@whetstone/contracts` (`nudgeContracts.ts`).
- Recitation routines (owned) (#577): `src/apps/server/src/features/recitation/` — adopt any Work
  (imported or authored) as a recitation plan. `recitationCommands.ts` (`createRecitationPlan` writes a
  `recitation_plan` `entries` row + shared `personal_entries` facet + `recitation_plans` row in one
  transaction; guards one-plan-per-(user,work) via `findRecitationPlanForWork` → `already_exists`; source
  Work is never copied. `setRecitationPhase`/`recordRecitationSession` are owner-scoped → `not_found`; a
  session bumps `session_count`/`last_session_at` only and never touches `personal_entries`, so it feeds
  no Timeline row or FSRS). `recitationQueries.ts` (`listRecitationPlans`, `getContinueRecitation` orders
  by `coalesce(last_session_at, created_at)` DESC). `recitationRoutes.ts` (current-user scoped,
  Zod-validated, `now`/`createEntryId` injected): `POST /api/recitation/plans` (201/400 work_not_found/409
  already_exists), `GET /api/recitation/plans`, `GET /api/recitation/continue`,
  `PUT /api/recitation/plans/:id/phase`, `POST /api/recitation/plans/:id/session`; wired in
  `createServer.ts`/`index.ts`. `diaryQueries.ts` joins `recitation_plans` into the Timeline as the
  `recitation` kind. DTOs in `@whetstone/contracts` (`recitationContracts.ts`).
- Recitation passage practice (owned) (#578): `src/apps/server/src/features/recitationPassages/` — the
  Learning-phase passage engine over a plan's Work. `recitationPassageCommands.ts`
  (`seedRecitationPassages` one passage per non-empty source block, idempotent; `splitRecitationPassage`/
  `mergeNextRecitationPassage` edit boundaries only + reindex `order_index` in a transaction, FSRS reset;
  `loadDueRecitationPassage` re-anchors against live block text before serving — unchanged/relocated/
  `needs_repair` — and derives the cue material + `defaultCueStrength` + the remembered `supportLevel`;
  `recordRecitationPassageReview`
  applies FSRS (#572) and appends a `recitation_reviews` history row; `setRecitationPassageSupportLevel`
  (#579) persists the per-passage support-level preference only — never FSRS). `recitationPassageQueries.ts`
  (owner-scoped loaders via the plan's `personal_entries` facet, source-order block load, next-due lookup,
  review counts, FSRS↔column mapping). `recitationPassageRoutes.ts` (current-user scoped, Zod-validated,
  `now`/`createEntryId`/`createId` injected): `POST /api/recitation/plans/:id/passages/seed`,
  `GET /api/recitation/plans/:id/passages`, `GET /api/recitation/passages/due` (registered before the
  parametric route), `POST /api/recitation/passages/:id/split|merge-next|review`,
  `PUT /api/recitation/passages/:id/support-level` (#579); the review route also accepts the #580
  `leadInFailed` flag (applies Again to the immediate predecessor when a lead-in failed); wired in
  `createServer.ts`/`index.ts`. `library/libraryCommands.ts` `deleteWork` cascades passages + reviews.
  DTOs in `@whetstone/contracts` (`recitationPassageContracts.ts`).
- Recitation chaining + whole-work maintenance (owned) (#580): same
  `src/apps/server/src/features/recitationPassages/` slice. `recitationChainingQueries.ts` (owner-scoped
  loaders for passage masteries, the active chain, and the whole-work card; reuses the passage FSRS↔column
  mappers). `recitationChainingCommands.ts` (`loadRecitationChaining` derives owned prefix + eligibility +
  active chain + whole-work state live; `startRecitationChain`/`completeRecitationChain` over the contiguous
  owned prefix, failing only an identified broken passage; `reviewWholeWork` schedules a separate lazily-created
  whole-work FSRS card; `loadRecitationToday` applies the bounded `selectRecitationTodayAction` priority).
  `recitationChainingRoutes.ts` (current-user scoped, Zod-validated): `GET /api/recitation/plans/:id/chaining`,
  `POST /api/recitation/plans/:id/chain` (201/400/404/422), `POST /api/recitation/chains/:id/complete`
  (200/400/404/409/422), `POST /api/recitation/plans/:id/whole-work/review` (200/400/404/409/422),
  `GET /api/recitation/today`; wired in `createServer.ts`/`index.ts`. DTOs in
  `@whetstone/contracts` (`recitationChainingContracts.ts`).
- Case/map content model: `src/features/cases/` (`caseSeed.ts` seeds the authored corpus on boot;
  `caseQueries.ts` `listDomains`/`listCasesInDomain`/`getCaseDetail`) over shared `domains` -> `cases`
  -> `chunks`. The case detail returns the chunk inventory plus a per-user mastery summary COMPUTED
  (never stored) from the user's `memory_prompts.chunk_id` links via `@whetstone/domain`
  `summarizeCaseMastery`. Corpus + mastery logic are pure in `@whetstone/domain`
  (`caseCorpus.ts`/`caseMastery.ts`); DTOs in `@whetstone/contracts` (`caseContracts.ts`).
- Case authoring (#209): `src/features/authoring/` — `authoringCommands.ts` (`authorCase` calls the coach
  seam to author a case + chunks into #205, persisted as `needs_review` and **cached by brief key** so a
  repeat brief reuses the stored case with no model call; `reviewCase` edits/accepts -> `active`) and
  `authoringQueries.ts` (`listCasesNeedingReview`, the curation queue). Cases carry a `status`
  (`active` default; authored start `needs_review`) and a unique `brief_key`; the practice ranking in
  `features/learner` only loads `active` cases, so unreviewed authored content is never practised.
  Shapes in `@whetstone/contracts` (`caseContracts.ts`).
- Memory MCP server: `src/apps/server/src/mcp/` exposes the Memory store to any MCP client (a local/cloud LLM coach) —
  `recallTools.ts` (the Memory-op tools: `deposit_memory` (#458/#595): a production-style deposit of a
  memory note + one-or-more prompts — captureSource/noteText/prompts (each cue + optional answer/gloss/
  provenance) — that reuses the `depositMemory` command directly (no proposal/review gate) and never
  accepts an integrity-bearing chunk link; plus `list_due_prompts`/`record_review`/`search_memory`/
  `get_memory_prompt`; all validate via contracts; `createRecallMcpServer`)
  and the stdio entry `mcp/main.ts` (run via `pnpm --filter @whetstone/server mcp`). Thin adapter; no
  logic duplicated. Tool list + transport: `docs/MCP.md`.
- Shared LLM seam: `src/llm/` — the one model-agnostic prompt→text boundary every server LLM caller
  (coach cheap tier, diary tidy, AI 解释) goes through. `llmModel.ts` exports the `LlmModel` type
  (`(prompt: string) => Promise<string>`), `createOllamaModel(model)` (local Ollama via the Vercel AI
  SDK over its OpenAI-compatible `/v1`, one shared `llmTimeoutMs`) and `probeOllamaModel(model)` (the
  boot health probe). This replaces the two former hand-rolled Ollama `fetch` clients and the hardcoded
  base URL; a later cloud model is a provider/base-URL swap behind the same `LlmModel` type.
- Coach LLM boundary: `src/coach/` — the coaching contract the language loop calls, composed over the
  shared `src/llm/` seam. `coachProvider.ts` (the `CoachProvider` interface: judge / ratingForScheduler /
  propose / author / converse / analyze), `fakeCoach.ts` (a deterministic, keyless fake so the loop builds
  and runs with no API key), `coachRouter.ts` (cost-routing — judge/converse/analyze=strong,
  propose/author=cheap, configurable) and `coachConfig.ts` (env-driven routing + an absent-config-safe
  `resolveCoach` that builds the cost-routed adapters whenever the adapter factory is wired — even with
  no key: the cheap/local tier runs, while `strong`-routed calls with no key resolve to the fake; it
  falls back to the plain fake only when no factory is wired). `converse` (#220) is the
  conversational next-turn call the live loop makes per user turn (no per-turn grading); `analyze` (#222)
  is the end-of-round one-pass call: the whole round (transcript + word-timings + the case's target chunks
  - compiled context) -> a rating per chunk, the top tagged mistakes, wins, and one native upgrade (the
    only place a round is graded). Both `converse` and `analyze` carry the adaptive **`CoachKnobs`** (#223)
    — difficulty/focus/probe-patterns derived deterministically from the learner model by `deriveCoachKnobs`
    (`@whetstone/domain` `coachKnobs.ts`), briefing the FIXED coach skill (no self-tuning yet). The knobs also
    carry the **bilingual language-mix dial** (#270): `targetL1Share` (from the learner's English share via
    `languageMix.ts`) lets the cheap-tier `converse` reply in the learner's EN/L1 mix while always pushing one
    English target; `englishShare(userTurn)` is recorded per turn on `session_exchanges` as the level signal.
    The verdict
    -> FSRS rating map is pure in `@whetstone/domain`
    (`coachGrade.ts` `judgementToRating`); boundary shapes/validation in `@whetstone/contracts` (`coachContracts.ts`).
    `coachAdapters.ts` composes the real tiers over the shared `src/llm/` seam — **cheap = local Ollama**
    (`llama3.1:8b` via `createOllamaModel`), **strong = cloud** — each wrapped over the fake so any
    model/parse failure
    still grades the round. `coachHealth.ts` is the boot probe (`checkCoachHealth`): it pings the
    local model on startup and reports `local_ready` / `local_unavailable` (with an `ollama pull`
    hint) / `cloud_only` / `fake`, so a missing model degrades cleanly to the fake instead of
    crashing. Deploy + provisioning steps: `docs/COACH.md`.
- Voice input (STT) seam: `src/coach/`'s sibling `src/speech/` — `speechInput.ts` (the `SpeechInput`
  interface: `transcribe({ path, language? }) -> { transcript, words[] }`), `fakeSpeechInput.ts` (deterministic, for
  the mic-less `pnpm validate` gate), `whisperSpeechInput.ts` (a local OSS Whisper adapter — builds the
  offline CLI args, using the per-request language before the `WHISPER_LANGUAGE` config fallback; validates
  the word-timestamped JSON at the boundary; maps to a `Transcription`),
  `whisperProcess.ts` (the injected execFile runner) and `speechConfig.ts` (env-driven, absent-config-
  safe `resolveSpeechInput` that stays on the fake until a Whisper binary+model are configured).
  `speechHealth.ts` (`checkSpeechHealth`, wired in `index.ts`, mirrors `checkCoachHealth`) logs a
  boot warning when STT is on the fake, pointing at `pnpm setup:voice`. The
  latency/inter-word-pause derivation is pure in `@whetstone/domain` (`speechTiming.ts`); shapes in
  `@whetstone/contracts` (`speechContracts.ts`). Audio never leaves the machine; setup in
  `docs/SPEECH.md`.
- Learner model: `src/features/learner/` — the retrieval half of the moat. `learnerCommands.ts`
  (`depositTurnOutcome` appends a turn + increments its categorized error pattern; `updateLearnerProfile`
  recomputes the rolling profile — level/strengths/weaknesses/focus — with an injectable phraser for the
  LLM seam) and `learnerQueries.ts` (`compileContext(now)` assembles a BOUNDED slice: rolling profile +
  top gap x frequency chunks + relevant errors + recent outcomes, each capped so size stays ~constant as
  history grows) over user-scoped `error_patterns`, `turn_outcomes`, `learner_profiles`. The gap x
  frequency ranking + level derivation are pure in `@whetstone/domain` (`learnerModel.ts`); shapes in
  `@whetstone/contracts` (`learnerContracts.ts`).
- Progress map: `src/features/map/` — `mapQueries.ts` `compileProgressMap(now)` composes #205 per-case
  mastery into lit/dim/dark light levels (`@whetstone/domain` `caseLightLevel`) over active cases, plus
  owned/weak counts and the #208 recommendation + error trend; exposed by `mapRoutes.ts` at
  `GET /api/progress-map`. Shapes in `@whetstone/contracts` (`mapContracts.ts`). Visualization only — no
  scoring logic.
- Practice session: `src/features/session/` — `sessionEngine.ts` orchestrates the turn loop over the
  coach (#206) and speech (#207) seams + #205/#208/#189: `startSession` proposes cues (top gap x
  frequency chunks; English situation, native target hidden), `submitTurn` judges + grades the
  submitted transcript and DEPOSITS (schedules the chunk's recall item #188/#189, enrolling on first
  practice, + records the turn outcome with its mistake category #208). The harvested first cue (#243):
  `harvestReadingCase(db, userId, now)` no longer leads with the strictly-newest capture — it reuses the
  nudge's `selectReadingNudgeCapture` (ranked gap×freq+recency, cooldown-excluded), so the Practice lead
  and the Today nudge propose the SAME case; when nothing qualifies (cold start / all in cooldown) it
  harvests nothing and the session falls back to authored cases. `converseTurn` (#220) holds a
  conversational coach turn: it loads the case, rebuilds the conversation from the persisted
  `session_exchanges` rows (append-only, user+case scoped, ordered by `order_index`), calls the coach's
  `converse`, persists the learner line + coach reply, and returns the reply (no per-turn grading).
  `endSession` (#222) is the end-of-round one pass: it rebuilds the round (transcript from
  `session_exchanges` + the request's word-timings + the case's target chunks + compiled context), calls
  the coach's `analyze`, and DEPOSITS the durable trace deterministically — chunk ratings -> FSRS recall
  (#188/#189, which also advances case mastery and so the map #210), tagged mistakes -> error-pattern
  counts (#208), and the rolling profile (#208) — then returns the compact debrief. The
  spoken path posts recorded audio bytes to `POST /api/session/transcribe` (optionally
  `?language=zh|en` for capture; the coach omits it and uses the fallback default), via injected
  `saveAudio` + speech, returning transcript + word-timings, and submits the recognized transcript; typing
  is the fallback. `sessionRoutes.ts`: `POST /api/session/` `start|transcribe|turn|say|end`. The
  coach/speech seams are resolved (fakes when unconfigured) in `index.ts`. Mistake-category map is pure in
  `@whetstone/domain` (`mistakeCategory.ts`); shapes in `@whetstone/contracts` (`sessionContracts.ts`).
  Web: the live **call surface** `SessionPage` (#221, #393) — before the call the page is a calm hero:
  the situation plus one primary **Start call** (End is not a peer yet). Tap it to talk continuously; the
  coach replies in voice, with **barge-in** and scrolling **live captions**, the call state
  (Ready/listening/thinking/speaking) leading and one **End & review** action. The typed box is the
  fallback, not a competing field: hidden behind a secondary **Type instead** when voice is supported,
  and shown automatically with a calm explanation only when voice is unsupported or the mic fails (the
  session stays usable). It wires the foundations end to end: continuous capture + endpointing
  (`liveCapture.ts`, #219) → STT (`transcribe`, #207) → coach (`say` → `/api/session/say`, #220) →
  browser TTS out (`voiceOut.ts`'s `createVoiceOut`, wired to `window.speechSynthesis` in the
  coverage-excluded `browserVoiceOut.ts`). The browser audio/speech boundaries (`liveCapture.ts`,
  `browserVoiceOut.ts`) are injected via the `live` prop and excluded from coverage; the loop
  orchestration, `pickEnglishVoice`/`createVoiceOut`, and `sessionApi` are covered. **End** runs the
  end-of-round analysis (`endSession`) and renders the compact **debrief** (`DebriefView`, #222):
  encouragement, the few moments (said -> native + why), the one upgrade, and what was scheduled for
  recall (each with its next-due date, so the debrief never contradicts the due-now Recall page — #478).
  After a soft time-box (`timeBoxMs`, ~15 min) the call surfaces a calm, non-blocking "land the plane"
  nudge offering to wrap up; the explicit **End** still works and the call is never hard-cut.
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
  `listCalendarDates` returns days-with-entries from `occurred_at`, `listDiaryEntriesForUser` is the
  coach-readable facet. Diary is the `kind === "diary"` filter over that result. `diaryRoutes.ts`:
  `POST /api/diary/entries`, `GET /api/diary/timeline?before&limit`, `GET /api/diary/calendar?from&to`,
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
  index, `phase` enum, `session_count`, nullable `last_session_at`),
  `recitation_passages` (#578 `entry_id` PK/FK, `plan_entry_id` FK + index, `order_index`, start/end
  `block_entry_id` + offsets, `source_text`, `context_snapshot`, `anchor_status` enum, `support_level` enum
  (#579, default `full`), per-passage FSRS
  card columns incl. `due_at`), `recitation_reviews` (append-only history: `id` PK, `passage_entry_id`
  FK + index, `rating`, `cue_strength`, `reviewed_at`), `recitation_chains` (#580 `id` PK, `plan_entry_id`
  FK + `(plan, status)` index, `end_order_index`, `status` active/completed, timestamps) and
  `recitation_whole_work` (#580 `plan_entry_id` PK/FK — one aggregate FSRS card per plan, created lazily on
  first whole-work review), links/templates, `reading_positions`, search indexes, and
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
  soft-deleted (unit-detached) blocks stay addressable; a work's Markdown can be exported
  (`GET /api/works/:id/content/markdown`, which keeps `loadWorkContent` server-side). The reader no
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
  structure + per-unit client-side.) `notes/` serves note templates and creates, lists, edits,
  and deletes notes (block-anchored, `annotates` link; scoped to a work through `blocks.work_entry_id`),
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
  `Sheet` over `WorkContentPanel`, Reader = `ReaderPage`, Practice =
  `SessionPage`, Progress = `ProgressMapPage`, Recall = `RecallPage`, Search = `SearchPage`, Notes =
  `NotesRoute`→`NotesPage` (reads `?work=<id>` to narrow to a single work), Diary = `DiaryPage`, Write =
  `AuthoredWorkPage` at `/write` — the immersive authored-Work editor, reads `?work=<id>`); `AppShell.tsx` is the responsive frame (one `Primary`
  `<nav>` styled as a desktop sidebar / mobile bottom-bar, wrapped in `SafeArea`, plus the single
  `ToastViewport` live region). `navigation.ts` holds the **five** primary destinations — Today,
  Library, Practice, **Map** (the user-facing label for the `/progress` route), Search — rendered as a
  **single non-wrapping row of ≥44px targets** on mobile (#390). Reader, Recall, Notes, and Diary keep
  their routes but are NOT primary: Reader is an immersive destination opened from context, and the
  others are reached from where they belong (Today links to Recall/Diary; Library links to the
  all-notes surface). The `ThemeToggle` is shell chrome in a slim top bar (never a tab, so it cannot
  wrap the mobile row). On the `/reader` and `/write` routes the nav (and the toggle bar) recede so the
  reading/writing column owns the viewport (immersive room); each provides its own back-to-Library control.
  Routing is hash-based (origin-independent for file/Capacitor/Tauri); tests use
  `MemoryRouter`.
- Base UI primitives: `src/shared/ui/` — `SafeArea` (`100dvh`/`svh` + safe-area insets, never
  `100vh`), `Button` (token variants via `cva`; a `pending` prop shows a `Spinner`, sets `aria-busy`,
  and disables so an in-flight action cannot double-submit), `Sheet` (Radix Dialog: focus trap +
  dismissal; right side panel on desktop / bottom sheet on mobile via `useMediaQuery`; tokenized Framer
  spring honoring reduced motion). Loading/pending state has two shared pieces: `Spinner.tsx` (CSS
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
  visibility gate is the pure `bubbleFormatting.ts`. The keyboard-first slash menu (#588) is one shared
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
  `contentApi.ingestPdf`/`ingestMarkdown`. Each card carries four
  actions — a reader link (`#/reader?work=<entryId>`, labelled **Continue** when the work has a saved
  reading position, else **Read** — armed by `libraryApi.fetchWorksWithReadingPosition` →
  `GET /api/reading-position/works` → the set of work ids with a position), a **Manage content**
  button (emits `onManageContent` up to `LibraryMode`, which opens the content sheet), a contextual
  **Notes** link (`#/notes?work=<entryId>`), and **Export Markdown**. Creating a work auto-opens its
  Manage-content sheet (add content right after create); an EPUB import does not. A **New document**
  action (#576) opens a minimal sheet (title/type/language — the current user is the author) that calls
  `authoredWorks/authoredWorkApi.createAuthoredWork` and hash-navigates into the editor
  (`#/write?work=<id>`); works the current user authored (loaded via `listAuthoredWorks`) carry an
  **Authored** badge and route their card's primary action to the editor (**Open** → `#/write?work=`)
  instead of the reader, hiding **Manage content**. `reader/` is **目录-driven and lazy-loads one reading unit at a time** (no whole-book
  transfer or freeze): it fetches the lightweight `…/structure` first (`buildReaderStructure`) and pulls
  each unit's blocks on demand via `…/units/:id/content` (`readerApi.ts`: `fetchWorkStructure` /
  `fetchUnitContent` / `locateBlockUnit` / `fetchWorkAnchorIndex`), with an explicit per-unit loading
  state and an error+Retry;
  `readerModel.ts` carries each block's stored mdast for direct, re-parse-free rendering (no Markdown
  round-trip; `blockToMarkdown` stays for the export path only);
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
  matched range(s) in an external `noteMark` span (`applyNoteHighlights.ts`); clicking or pressing
  Enter on a highlight opens its note. Resolution is block-id + offset first (`blockText.ts` maps the
  shared character-offset model to/from DOM ranges, `spanMarks.ts` splits a span across blocks), then
  a W3C **TextQuote** re-anchor (`textHighlight.ts`, dependency-free) using the stored
  `selectedTextSnapshot` (+ `contextSnapshot` as prefix/suffix) when the offsets no longer fit (doc
  edit / re-ingest); `textHighlight.ts` also wraps a resolved range's text nodes in the highlight
  span(s).
  Cross-block notes are first-class — highlighted from the start block's tail through every middle
  block to the end block's head. A whole-block note (no offsets) shows a restrained hue gutter bar
  with a "View note" affordance instead of an underline. The reader opens the
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
  chrome — a minimal title + a thin top progress line plus the one home for every reading tool
  (text-size, Day/Night `ThemeToggle`, the 目录 toggle as a contents icon, and the notes toggle),
  laid out as a **persistent vertical icon rail docked at the bottom-right on desktop** (beside the
  reading column, always one click away — it stays put while scrolling, never receding) and a **top bar
  plus a bottom tools bar shown by default on mobile** (a center
  tap on the reading area recedes/restores it; it must not start receded, else the tools sit below the
  fold and are untappable — #511; `ReaderPage.tsx` owns the narrow-screen tap state). On mobile the
  whole chrome recedes as one through the `data-hidden` flag; on desktop only the title recedes on
  scroll-up (via `useReaderScroll.ts`) while the tool rail persists. `readingSize.ts` holds the
  text-size steps (`--reading-size`); `annotationHue.tokens.ts` maps a note template to its hue key
  for the highlight (`noteMark--<hue>`, applied by `applyNoteHighlights.ts`) and whole-block gutter
  (`readerBlock--<hue>`) classes.
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
  area (manual **paste-Markdown** editor only — bringing a file in is the shelf **Upload** control's
  job (#417); this panel edits an existing Work's content via `ingestMarkdown` — #418) reporting the ingestion result, and a units/blocks overview
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
  → next `before` page), and a **date-jump mini-calendar** marks days-with-entries (from the calendar
  endpoint, pure `monthGrid`/`monthBounds`/`shiftMonth`) and scrolls to a chosen day (loading older pages
  until it is present); per-entry edit + delete and an explicit empty state. `diaryApi.ts` calls the
  `/api/diary/*` endpoints (`submitDiaryCapture` → `DiaryEntryDto`, `updateDiaryEntry(id, bodyDoc)`) and
  parses every response through `diaryContracts`. The "Mine my history" action and all Make Durable /
  proposal card UI are gone.
  `recall/` is the Recall mode (#318): `RecallPage.tsx` lists today's **due** prompts (already capped
  server-side) as gentle, snoozeable proposals — each card is a **two-phase flip** (#525): phase 1
  shows the prompt's `cueText` (front) + **Show answer** + Snooze and **no** grades; after reveal it shows
  the `answerText` (back) and the four self-rating controls (Again/Hard/Good/Easy → the FSRS `rating` posted
  to the review route). A due prompt always carries a real answer (a scheduled Memory prompt requires both
  cue and answer, #595), so there is no answerless self-check face. Grading or snoozing advances past the
  prompt, with explicit loading/error/empty ("all caught up") states. The reader stays calm — recall lives
  only here. `recallApi.ts` calls `/api/recall/*` (`MemoryPromptCardDto`) and parses via `memoryContracts`.
  `today/` is the proactive Today home (#319) and the app's landing (`/`): `TodayPage.tsx` is a calm,
  finite, clearable single column (PRODUCT "v0 assistant home (Today)" + "The arranger") that COMPOSES
  already-built slices — a greeting, an always-present voice-diary quick-capture linking to `/diary`,
  a restrained Recall card (`fetchDueRecall`: the first due item at a glance + a Review link to
  `/recall`, else a quiet "caught up" line), a Continue-reading card (`todayApi.fetchLatestReadingPosition`
  → `GET /api/reading-position/latest`, deep-linking `#/reader?work=`, else a quiet line), a
  Continue-writing card (#576, `authoredWorks/authoredWorkApi.fetchContinueWriting` →
  `GET /api/authored-works/continue`, the most recently edited authored Work, deep-linking
  `#/write?work=`, else a quiet "no drafts yet" line), a Continue-recitation card (#577,
  `recitation/recitationApi.fetchContinueRecitation` → `GET /api/recitation/continue`, the most recently
  touched recitation plan with its Work title + phase; **Continue** records a session and deep-links
  `#/reader?work=`, and only while `familiarizing` an explicit **Start reciting** transitions to
  `learning`; else a quiet line), a **Recite** card (#578/#580, the single bounded recitation action
  decided server-side via `recitation/recitationChainingApi.fetchToday` → `GET /api/recitation/today`,
  in fixed priority due passage > active chain > whole-work > none) that either runs the next due passage
  inline as one `RecitationReviewCard` attempt (payload from `recitationPassageApi.fetchDuePassage`,
  `GET /api/recitation/passages/due`) — re-deciding the next action only after it is reviewed (no overdue
  wall) — or surfaces a chain / whole-work invitation linking to `#/recite?plan=<id>` (caught-up/quiet-note
  otherwise), and the
  reading→practice nudge card (#245) in its `nudge/` slice: `nudgeApi.ts` `fetchNudge` (`GET /api/nudge`,
  null → undefined) renders ONE quiet, dismissible card — "Practise _‹snippet›_ from _‹work›_" with an
  accept link to `/practice` (where `startSession` leads with the same proposed case) and a ✕ that calls
  `dismissNudge` (`POST /api/nudge/:chunkId/dismiss`, cooldown) and removes the card at once; absent on
  null/loading/error (no placeholder). When the actionable arms clear (no recall due AND no present
  nudge) it shows a compassionate "done for today" — NO streak/guilt/penalty. Each async arm loads
  independently so one failing never blanks the page; the reader stays calm.
  `authoredWorks/` is the owned-Work editor slice (#576): `AuthoredWorkPage.tsx` is the immersive
  `/write?work=<id>` surface that loads a user-authored Work's canonical ProseMirror document
  (`authoredWorkApi.fetchAuthoredWork`), edits it in the shared `RichContentEditor`, and reads it back
  through the same reader renderer (`reader/PmDocument`) with no format conversion — a missing/failed
  load falls back to a calm inline state. `useAutosave.ts` is a debounced (800ms), serialized,
  latest-write-safe autosave hook (5-state `idle|unsaved|saving|saved|error`; `saveAuthoredWorkContent`
  → `PUT /api/authored-works/:id/content`); `useUnsavedChangesWarning.ts` guards navigation while a save
  is pending. `authoredWork.tokens.ts` holds the pure status→label/class maps (coverage-excluded).
- Recitation routines (#577): `src/apps/web/src/features/recitation/` — `recitationApi.ts` (client for
  `/api/recitation/*`, every response parsed through `recitationContracts`) and `recitationLabels.ts`
  (learner-facing phase label + hint copy, exercised by the component tests). Adoption lives on the
  Library page: `library/AdminLibraryPage.tsx` shows a **Practise recitation** action per Work that opens
  an initial-phase picker Sheet (`createRecitationPlan`), and marks an already-adopted Work with a quiet
  "Reciting · ‹phase›" status instead; the Today Continue-recitation card is described above.
- Recitation passage practice (#578): `src/apps/web/src/features/recitation/` (same slice) —
  `recitationPassageApi.ts` (client for the passage endpoints — seed/list/due/split/merge-next/review/
  set-support-level (#579) — every response parsed through `recitationPassageContracts`),
  `RecitationReviewCard.tsx` (one due passage
  as a two-phase attempt: a #579 support-level ladder (**Full**/**Reduced**/**First characters**/**Hidden**,
  rendering the pure `projectRecitationSupport` projection with masked runs announced as "hidden text";
  remembered per passage via `setSupportLevel`, reduced-motion honored) → **Reveal** → the four FSRS-mapped
  self-ratings (a #580 "lead-in failed" checkbox appears in the revealed phase when a preceding-line cue
  exists, so a missed lead-in also lapses the predecessor); a
  `needs_repair` passage shows a repair notice instead of stale text; only the final rating posts), and
  `RecitePage.tsx` — the `/recite?plan=<id>` segmentation surface (seed, then split/merge passage
  boundaries with per-passage review progress; canonical Work text untouched), routed in `app/AppRoutes.tsx`.
  Support-level and cue-strength labels live in `recitationLabels.ts`; the Today **Recite** card composes `RecitationReviewCard`.
- Recitation chaining + whole-work maintenance (#580): `src/apps/web/src/features/recitation/` (same slice) —
  `recitationChainingApi.ts` (client for the chaining endpoints — `fetchChaining`/`startChain`/`completeChain`/
  `reviewWholeWork`/`fetchToday`, every response parsed through `recitationChainingContracts`) and
  `RecitationChainingPanel.tsx` — the maintenance surface rendered below the passage list on `RecitePage`
  when passages exist: the contiguous owned prefix, a **Start chain** boundary picker (eligible once the first
  two passages are owned), an active chain (recite in order, then "Recall held throughout" or "Recall broke
  here" on one identified passage), and, once every passage is owned, a **Whole-work maintenance** prompt with
  the four ratings + an optional break-point `<select>`. Reloads live after each action; nothing is a Timeline
  Entry. The E2E `e2e/tests/recitation-chaining.spec.ts` drives owned-prefix → chain → whole-work end to end.
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
  `NSMicrophoneUsageDescription` (Practice voice, AC #4) to the generated Info.plist. `scripts/` hold
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
- Setup (one command): `pnpm setup` (`scripts/setup.mjs`) — a declarative, extensible bootstrap. The runner (`scripts/setup/runner.mjs`) runs each step (`scripts/setup/steps/*.mjs`: toolchain check, install, build, Playwright Chromium, `.env` scaffold) through `check -> provision -> verify`, idempotent and fail-loud (each non-ok `StepResult` carries `what` + `remedy`). A **bare `pnpm setup` is the full install**: `selectSteps` defaults to base **plus every optional capability** (voice + coach + PDF), consent-gated — so one flag-free command reaches a fully-capable app; `--all` is a harmless alias of this default. `pnpm setup:minimal` (`--minimal`) narrows to base-only (lean / CI / reader-only); `pnpm setup:doctor` reports readiness without mutating. Single capabilities can still be (re)run on their own — `pnpm setup:voice`, `pnpm setup:coach`, `pnpm setup:pdf`, `pnpm setup:all` — because `setup` is a built-in pnpm command, so passing a flag to a bare `pnpm setup` routes to the built-in and fails. A raw flag/env combo (e.g. `--yes` to pre-consent installs) goes through the explicit `pnpm run setup -- --<flag>` escape hatch (`pnpm run setup -- --yes` = fully unattended). A system prerequisite is installed only through the consent seam `ctx.confirm` (`scripts/setup/confirm.mjs`; real stdin/tty wiring in `context.mjs`) via the reusable, consent-gated `installSystemTool` helper (`scripts/setup/installSystemTool.mjs`: check → package-manager detect → Y/N → install → on win32 refresh PATH from the registry and re-resolve so an install→use flow completes in one run, else name the stale-shell-PATH cause; instruct-only fallback on decline / no manager / non-interactive). The optional **voice** step (`scripts/setup/steps/voice.mjs`, `--voice`) installs faster-whisper + the bundled `whetstone-whisper` pip console-script wrapper (`scripts/setup/whisper-wrapper/`, emits the `docs/SPEECH.md` JSON contract), fetches the model, and writes `WHISPER_*` to `.env`; its Python 3 prerequisite is the first `installSystemTool` consumer (winget/brew after a Y, else instruct-only). The optional **coach** step (`scripts/setup/steps/coach.mjs`, `--coach`) is the second `installSystemTool` consumer: it installs Ollama (winget/brew/official-script after a Y, else instruct-only), pulls the converse (`llama3.1:8b`, override `COACH_MODEL`) + explain (`qwen2.5`, override `EXPLAIN_MODEL`) models, verifies each answers through the daemon, and writes `COACH_MODEL` + `EXPLAIN_MODEL` + `COACH_CONVERSE_TIER=cheap` + `COACH_ANALYZE_TIER=cheap` (never `COACH_API_KEY`) to `.env` for a fully-local coach (`docs/COACH.md`). The optional **pdf** step (`scripts/setup/steps/pdf.mjs`, `--pdf`) provisions the PDF-ingestion lane: it checks Python + the Docling pip package + OCRmyPDF + Tesseract, reporting each missing piece distinctly, installs Python (consent-gated) then `pip install docling`, and leaves the heavy OCRmyPDF/Tesseract system tools consent-gated (brew) or instruct-only (no clean install, e.g. Windows). The `.env` line read/upsert helpers are the shared owner `scripts/setup/env-file.mjs` (used by both voice and coach). Real I/O is confined to `scripts/setup/context.mjs`. Adding a runtime dependency = drop one step file here (GUIDELINES "Setup steps" gate).
- Dev (one command): `pnpm dev` (`scripts/dev.mjs`) builds the shared packages once, then runs the API server from source with reload (`tsx watch`) and the Vite web dev server together — route changes go live with no manual `build`. Production still runs the built `dist` via `pnpm --filter @whetstone/server start`.
- Gate: `pnpm validate` (= `typecheck && lint && test && build && smoke && e2e`); mirrors `.github/workflows/ci.yml`. `smoke` (`src/apps/web/dev-smoke.mjs`) boots the Vite dev server and checks every dependency resolves at serve time — catching dev-only breakage that `build` (rolldown) does not.
- Mutation testing (advisory, non-gating): `pnpm mutation` (Stryker, `stryker.conf.mjs`) plants mutants over `@whetstone/domain` + `@whetstone/contracts` to surface shallow tests that pass at 100% coverage — backing the GUIDELINES mutation-resistance rule. It uses a scoped `vitest.stryker.config.ts` (only those packages' tests) with the same `@whetstone/*` aliases, writes `reports/mutation/`, and runs nightly via `.github/workflows/mutation.yml` (uploads the report). Never part of `pnpm validate`; `break` unset so it can't fail a merge; `thresholds.low` is the advisory baseline. Extend the `mutate` globs to add a package later.
- Deploy (continuous, to a personal MacBook): `.github/workflows/deploy.yml` runs **only on push to `main`**, `runs-on: self-hosted`, gated on the `DEPLOY_ENABLED` repo variable (skips until set). It builds, then restarts a `launchd` app service that serves the single origin (web `dist` + `/api`) and migrates on boot; `DATABASE_DIR` persists across deploys; HTTPS via a Cloudflare Tunnel. Setup runbook: `docs/DEPLOY.md`.
- E2E smoke (merge gate): `pnpm e2e` (`e2e/`, `@playwright/test`) boots the real stack — Fastify + in-memory PGlite + the Vite **dev** server (React dev mode) — seeded with a fixture EPUB and a small Markdown work, then drives the core reader loop in Chromium (open work → chapter; select in paragraph/blockquote/list → toolbar; add note → reload-persists; look up a word → definition). Every test fails on any console error, app-origin HTTP 4xx/5xx, or React hydration/DOM-nesting warning (`e2e/fixtures.ts`). Boot/seed harness: `e2e/stack.ts` + `e2e/globalSetup.ts`. CI installs Chromium (`playwright install --with-deps chromium`). Deterministic in-page visual probes for the tester (`e2e/probes.ts`: `contrast` / `geometry` / `contentPresent` + an `overlaps` helper, each self-contained for `page.evaluate`) and their integration spec (`e2e/tests/probes.spec.ts`, static `setContent` fixtures) let a visual `[Bug]` be filed on a computed value/rect instead of a screenshot.
- Screenshots (manual, outside the gate): `pnpm screenshots` (`scripts/screenshots.mjs`) boots the real stack on an ephemeral in-memory DB, ingests the public-domain `fixtures/epub/` files through the live pipeline, serves the production build via `vite preview`, and drives Playwright Chromium to write per-stage PNGs to `artifacts/screenshots/` (git-ignored): Today at the root route, Library at `#/library`, and the Reader — each across the Day/Night × desktop/mobile matrix — plus the selection → note-editor → note-saved annotation moment. `scripts/make-fixture-epub.mjs` regenerates the English fixture. Needs `pnpm exec playwright install chromium` once.
- Workflow roles: `.github/agents/*.agent.md` (design, developer, reviewer, tester). The **tester** (QA) is the exploratory bug-discovery layer above the E2E gate — `scripts/run-tester.cmd` / `run-tester-auto.cmd` + `scripts/tester-next-action.mjs` (queue-driven per-run filing budget); it boots the real stack on `main`, drives the app beyond the smoke, and files de-duplicated `[Bug]`s (read-only on code). Operational quick-reference: the
  `whetstone-engineering` skill in `.github/skills/`.
