# Repository map

Navigational index: subsystems to their locations. **Pointers and invariants only — never
restated code behavior.** Read `PRODUCT.md` and `GUIDELINES.md`, then this map, then only the one
feature slice you need. Maintained per `GUIDELINES.md` -> "Knowledge surfaces and onboarding cost":
updated by the same PR that changes an area's shape, not on every change.

When a folder below outgrows its single entry here, give it a colocated `AGENTS.md` and shrink its
entry to a pointer.

## Packages

### `src/packages/domain/` — pure logic

Entry/link/block/template/note-anchor rules with no React, Fastify, DB, fs, or env. Public surface is
`src/index.ts`. Current units: `entry.ts`, `links.ts`, `block.ts`, `markdownBlocks.ts` (decompose
Markdown into ordered, stable-id blocks; exports the shared `blockFromMdastNode` mapper, which
strips image nodes — v0 is text blocks only — and skips a block left empty by that removal),
`blockDiff.ts` (content-similarity diff matching new blocks to existing ones — Dice-bigram alignment —
to preserve stable ids on re-ingestion), `htmlBlocks.ts` (decompose one EPUB chapter's XHTML into a
reading unit of blocks via `rehype-parse` + `rehype-remark`), `epubMetadata.ts` (normalize OPF
title/author/language), `blockMarkdown.ts` (serialize a block's mdast back to Markdown for safe
rendering; `blocksToMarkdown` reconstructs a whole work for export), `author.ts`, `work.ts`,
`noteTemplate.ts` (v0 note templates +
size-based preselection), `noteAnswers.ts` (answer validation + note-body Markdown), `noteAnchor.ts`
(anchors a note to a block id with an optional sub-block offset range), `productIdentity.ts`. Tests
are colocated `*.test.ts`. Invariant: depends on nothing outward.

### `src/packages/contracts/` — shared API schemas/DTOs

Zod request/response contracts shared by client and server. Public surface is `src/index.ts`.
Current contracts: `entryContracts.ts`, `libraryContracts.ts`, `contentContracts.ts`,
`noteContracts.ts`, `lookupContracts.ts` (the lookup route query validator + the shared
`NormalizedEntry` shape and `LookupResponse` DTO rendered by the reader), `health.ts`. Tests colocated.
Invariant: types resolve through built `dist` — run `pnpm build` (or `tsc -b`) before VS Code/tsc
can navigate them from another package.

## Apps

### `src/apps/server/` — Fastify API

- Composition/entry: `src/index.ts`; server assembly in `src/http/createServer.ts`.
- Config: `src/config/serverConfig.ts`.
- Data: `src/db/` — `schema.ts` (Drizzle), `dbClient.ts`, `migrate.ts`, `migrations/`.
- Features (feature-first): `src/features/<feature>/` with `*Routes.ts`, `*Commands.ts`,
  `*Queries.ts` (current: `library/`, `content/`, `notes/`). Routes stay thin; logic lives in
  commands/queries. `content/` ingests Markdown and EPUB uploads. Markdown re-ingestion REPLACES a
  work's content via the domain block diff (`blockReconciler.ts` preserves matched block ids, inserts
  new, soft-deletes removed — `blocks.deleted_at` set + detached `reading_unit_entry_id`); identical
  source is a no-op. EPUB uploads (`epubCommands.ts`) create the Work from OPF metadata and are
  sha256-idempotent, persisting via `blockWriter.ts`. Both writers bulk-insert through
  `insertBatching.ts` (`insertInBatches` chunks every multi-row INSERT under PostgreSQL's 32767
  bind-parameter limit so large works persist; `assertContentPersisted` turns a silent zero-row
  rollback into a 5xx instead of a false 201). Blocks carry `work_entry_id`, so notes on
  soft-deleted (unit-detached) blocks stay addressable; a work's Markdown can be exported
  (`GET /api/works/:id/content/markdown`). `notes/` serves note templates and creates, lists, edits,
  and deletes notes (block-anchored, `annotates` link; scoped to a work through `blocks.work_entry_id`);
  templates are seeded from the domain on boot
  (`seedNoteTemplates`).
- Source files: `src/files/sourceFileStore.ts` — persists uploaded/manual Markdown and uploaded
  `.epub` bytes under a server-generated path with sha256 (path-traversal-guarded) for provenance
  only; blocks remain the source of truth. `src/files/epubSource.ts` — the EPUB parsing boundary
  (`@lingo-reader/epub-parser`): bytes in, normalized metadata and ordered chapter HTML out (injected
  so commands test against a fake parser).
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
  `import.meta.url`) and `pnpm build` copies `src/lookup/data` into `dist/lookup/data`. Each
  `LookupSource` declares the `languages` it serves; `lookupService.ts` routes by language (English →
  the composed English lookup; Chinese `zh-CN`/`zh-TW` → CC-CEDICT), returns the first composed
  `DictionaryEntry`, and caches by `language:term`. Every contributing source's attribution rides in
  the entry's `sources`. `wordpos` runs its bundled-index build step via pnpm's `allowBuilds` in
  `pnpm-workspace.yaml`. The adapters are pure (tested against canned data via the fake transport /
  sample text, plus one offline integration test against the real WordNet database).
  The route lives in `src/features/lookup/lookupRoutes.ts` (`GET /api/lookup?term=&language=`,
  language is `en`/`zh-CN`/`zh-TW`, thin: validates the query contract, delegates to the service).
- Tests colocated `*.test.ts`. Invariant: PostgreSQL is the content source of truth; blocks are rows.

### `src/apps/web/` — React + Vite PWA

- Entry: `src/main.tsx` (imports the self-hosted fonts + `styles/theme.css`, mounts `<MotionConfig
reducedMotion="user">` + `<HashRouter>`); root `src/App.tsx` renders the routed shell.
- App shell + routing: `src/app/` — `AppRoutes.tsx` nests the four modes under the `AppShell` layout
  route (Library = `AdminLibraryPage` + `WorkContentPanel`, Reader = `ReaderPage`, Notes/Search =
  `ModePlaceholder` until their slices land); `AppShell.tsx` is the responsive frame (one `Primary`
  `<nav>` styled as a desktop sidebar / mobile bottom-bar, wrapped in `SafeArea`, hosting the
  `ThemeToggle` in its footer and the single `ToastViewport` live region) with `navigation.ts`
  destinations. On the `/reader` route the nav (and its `ThemeToggle`) recedes so the reading column
  owns the viewport (immersive reading room); the reader provides its own back-to-Library control.
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
  `.dark` class + persists, `ThemeToggle.tsx` the sun/moon icon button mounted in the shell footer); `src/shared/motion/motion.ts` holds motion tokens +
  the `withReducedMotion` guard. The legacy `styles.css` is kept until screens migrate to tokens.
- Features: `src/features/<feature>/` with page + `*Api.ts` (current: `library/`, `content/`,
  `reader/`, `notes/`, `lookup/`). `library/` is the admin home: `AdminLibraryPage.tsx` shows works as cards
  grouped by author (`groupWorksByAuthor.ts`) with an "Add work" `Sheet` dialog, and uploads
  an `.epub` to create a Work (`libraryApi.ingestEpub` posts the raw bytes); each card's "Continue
  reading" deep-links to `#/reader?work=<entryId>` (with an optional `&block=<entryId>` to open a
  specific block). `reader/` is **目录-driven and renders one reading unit at a time** (no whole-book
  freeze): `readerModel.ts` orders units/blocks and serializes each block via domain `blockToMarkdown`;
  `readerNavigation.ts` holds the pure unit-selection logic (which unit holds a block, the initial unit
  for a deep link, TOC labels, work-level progress); `ReaderToc.tsx` is the 目录 — a dismissable
  drawer at every width (toggle + backdrop, never a persistent sidebar) listing units with the current
  one marked. `ReaderPage.tsx` is the immersive single-column reading room: a work is opened from the
  Library via `?work=` (no in-reader work-picker or page heading; with no work open it shows an explicit
  "Open a work from your Library" empty state), with a back-to-Library hash anchor always reachable. It
  keeps an `activeUnitIndex`,
  renders only that unit safely with `react-markdown` + `rehype-sanitize` (a schema that also disallows
  `img`, so no image is fetched/rendered; an `a` component override renders the source's in-content
  links as non-navigating `readerLink` spans so a click selects text instead of hijacking navigation —
  v0 has no cross-document in-book link resolution; opening the `?work=`/`?block=` target on arrival via
  `AppRoutes`' `ReaderRoute`), tags each block with `data-block-id`, highlights blocks
  that have notes (and lets the reader reopen them). The reading `article` is whetstone's own
  selection surface: it prevents the right-click `contextmenu` and uses `-webkit-touch-callout: none`
  with `user-select: text` so the mobile/Capacitor long-press callout doesn't collide with the
  toolbar while text stays selectable (the desktop browser selection mini-menu is a user setting,
  out of scope). Selecting text (`blockSelection.ts`
  reads the selected text and its offset from the live Range; `selectionRect.ts` reads the
  Range rect for anchoring) opens a floating `SelectionToolbar` (size-preselected, hue-switchable
  template) on mouse-up, key-up, or touch-end; confirming opens the `notes/` editor, and a saved
  block's highlight is "born" via `highlightBirth.ts`. It also shows
  a per-work note list; jumping back from a note card loads the unit holding the block (when it differs
  from the open one) then scrolls/focuses it via `scrollToBlock.ts`. The reader is the calm `paper` reading surface (`.reading-surface` +
  `readerPaper`, `lang` from the work for CJK measure): `ReadingHeader.tsx` is the auto-hiding header
  (title + work-level progress + text-size control) driven by `useReaderScroll.ts`; `readingSize.ts` holds the
  text-size steps (`--reading-size`); `annotationHue.ts` maps a note template to its highlight hue.
  Block content (lists, code, blockquotes, tables, footnotes) renders to the PRODUCT.md readability
  targets via the `.reader` rules in `styles/theme.css` (even rhythm owned by `.readerBlock`, restored
  list markers, monospace code surface, ~66ch measure); `readerHeadings.ts` decides when a unit's
  eyebrow title duplicates its first heading (`isUnitTitleRedundant`) so the title is not shown twice,
  and `readerModel` flags heading blocks via `ReaderBlock.isHeading`.
  Reading position is remembered per work in localStorage (client-side UI state, never server truth):
  `readingPosition.ts` is the pure compute/restore/serialize layer (`resolveOpening` picks the opening
  unit/scroll target from a deep link or saved position, `createLocalStoragePositionStore` injects
  storage), and `useReadingPositionWriter.ts` persists the current unit + debounced scroll offset so
  reopening a work resumes where it left off.
  `notes/` is the note feature: `noteCapture.ts` turns a block selection into a
  draft, `SelectionToolbar.tsx` is the anchored capture toolbar, `templateHue.ts` maps a template to
  its control swatch, `NoteEditor.tsx` is the template-based create/edit editor hosted in the shared
  `Sheet` with a hued segmented template control, `NoteList.tsx` renders notes as hued cards
  (template chip + snippet + answers) with jump-back/edit/delete,
  `notesApi.ts` calls the templates/notes endpoints. Shared `ui/Toast.tsx` shows transient,
  reduced-motion-aware status confirmations. `lookup/` is the view-only vocabulary lookup: selecting
  text exposes a "Look up" action on the `SelectionToolbar`; `LookupPanel.tsx` renders the enriched
  `DictionaryEntry` as a mature online-dictionary card — headword with pronunciations (and an audio
  control when available), color-coded part-of-speech sections (`partOfSpeechHue.ts` maps each part of
  speech to a tokenized, Day/Night hue class), numbered senses with italic examples and synonym chips,
  a quiet etymology line, and a sources footer — in a compact Radix popover anchored near the selection
  on desktop/tablet, and a content-height bottom `Sheet` on narrow screens (it scrolls for long
  entries), with explicit loading/empty/error states. `lookupApi.ts` calls `GET /api/lookup`. The
  reader passes the open work's language so Chinese selections route to CC-CEDICT automatically. Lookup
  never creates, pre-fills, or edits a note.
  `content/` is the Work detail surface (`WorkContentPanel.tsx`): a work switcher, a header
  (title/author/type/language + unit/block counts via `workContentSummary.ts`), an "Open in Reader"
  deep-link, a calm add-content area (manual Markdown + `.md` upload) reporting the ingestion result,
  and a units/blocks overview; `contentApi.ts` calls the content/ingest endpoints.
- Cross-feature UI lands in `src/shared/ui/`, client API helpers in `src/shared/api/` (created when
  first needed). Tests colocated `*.test.ts(x)`.

## Build, validate, run

- Workspace: pnpm + TypeScript project references. `pnpm install` then `pnpm build` before first use.
- Run/use walkthrough: `docs/QUICK_START.md` (install, env/data config, run server + web, first note flow).
- Gate: `pnpm validate` (= `typecheck && lint && test && build && smoke`); mirrors `.github/workflows/ci.yml`. `smoke` (`src/apps/web/dev-smoke.mjs`) boots the Vite dev server and checks every dependency resolves at serve time — catching dev-only breakage that `build` (rolldown) does not.
- Screenshots (manual, outside the gate): `pnpm screenshots` (`scripts/screenshots.mjs`) boots the real stack on an ephemeral in-memory DB, ingests the public-domain `fixtures/epub/` files through the live pipeline, serves the production build via `vite preview`, and drives Playwright Chromium to write per-stage PNGs to `artifacts/screenshots/` (git-ignored). `scripts/make-fixture-epub.mjs` regenerates the English fixture. Needs `pnpm exec playwright install chromium` once.
- Workflow roles: `.github/agents/*.agent.md` (design, developer, reviewer). Operational quick-reference: the
  `whetstone-engineering` skill in `.github/skills/`.
