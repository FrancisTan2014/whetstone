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
Markdown into ordered, stable-id blocks; exports the shared `blockFromMdastNode` mapper),
`htmlBlocks.ts` (decompose one EPUB chapter's XHTML into a reading unit of blocks via
`rehype-parse` + `rehype-remark`), `epubMetadata.ts` (normalize OPF title/author/language),
`blockMarkdown.ts` (serialize a block's mdast back to
Markdown for safe rendering), `author.ts`, `work.ts`, `noteTemplate.ts` (v0 note templates +
size-based preselection), `noteAnswers.ts` (answer validation + note-body Markdown), `noteAnchor.ts`
(anchors a note to a block id with an optional sub-block offset range), `productIdentity.ts`. Tests
are colocated `*.test.ts`. Invariant: depends on nothing outward.

### `src/packages/contracts/` — shared API schemas/DTOs

Zod request/response contracts shared by client and server. Public surface is `src/index.ts`.
Current contracts: `entryContracts.ts`, `libraryContracts.ts`, `contentContracts.ts`,
`noteContracts.ts`, `health.ts`. Tests colocated.
Invariant: types resolve through built `dist` — run `pnpm build` (or `tsc -b`) before VS Code/tsc
can navigate them from another package.

## Apps

### `src/apps/server/` — Fastify API

- Composition/entry: `src/index.ts`; server assembly in `src/http/createServer.ts`.
- Config: `src/config/serverConfig.ts`.
- Data: `src/db/` — `schema.ts` (Drizzle), `dbClient.ts`, `migrate.ts`, `migrations/`.
- Features (feature-first): `src/features/<feature>/` with `*Routes.ts`, `*Commands.ts`,
  `*Queries.ts` (current: `library/`, `content/`, `notes/`). Routes stay thin; logic lives in
  commands/queries. `content/` ingests Markdown (`contentCommands.ts`) and EPUB uploads
  (`epubCommands.ts`, which creates the Work from OPF metadata and is sha256-idempotent); both share
  `blockWriter.ts` for reading-unit/block/link persistence. `notes/` serves note templates and
  creates, lists, edits, and deletes notes
  (block-anchored, `annotates` link); templates are seeded from the domain on boot
  (`seedNoteTemplates`).
- Source files: `src/files/sourceFileStore.ts` — persists uploaded/manual Markdown and uploaded
  `.epub` bytes under a server-generated path with sha256 (path-traversal-guarded) for provenance
  only; blocks remain the source of truth. `src/files/epubSource.ts` — the EPUB parsing boundary
  (`@lingo-reader/epub-parser`): bytes in, normalized metadata and ordered chapter HTML out (injected
  so commands test against a fake parser).
- Tests colocated `*.test.ts`. Invariant: PostgreSQL is the content source of truth; blocks are rows.

### `src/apps/web/` — React + Vite PWA

- Entry: `src/main.tsx`; root `src/App.tsx`; styles `src/styles.css`.
- Features: `src/features/<feature>/` with page + `*Api.ts` (current: `library/`, `content/`,
  `reader/`, `notes/`). `library/` is the admin: `AdminLibraryPage.tsx` adds authors/works and uploads
  an `.epub` to create a Work (`libraryApi.ingestEpub` posts the raw bytes). `reader/` renders a work as one continuous scroll: `readerModel.ts` orders
  units/blocks and serializes each block via domain `blockToMarkdown`; `ReaderPage.tsx` renders safely
  with `react-markdown` + `rehype-sanitize`, tags each block with `data-block-id`, highlights blocks
  that have notes (and lets the reader reopen them), and on a block selection (`blockSelection.ts`
  reads the selected text and its offset from the live Range) opens the `notes/` editor; it also shows
  a per-work note list. `notes/` is the note feature: `noteCapture.ts` turns a block selection into a
  draft, `NoteEditor.tsx` is the template-based create/edit editor (side panel / bottom sheet),
  `NoteList.tsx` lists notes with edit/delete, `notesApi.ts` calls the templates/notes endpoints.
- Cross-feature UI lands in `src/shared/ui/`, client API helpers in `src/shared/api/` (created when
  first needed). Tests colocated `*.test.ts(x)`.

## Build, validate, run

- Workspace: pnpm + TypeScript project references. `pnpm install` then `pnpm build` before first use.
- Run/use walkthrough: `docs/QUICK_START.md` (install, env/data config, run server + web, first note flow).
- Gate: `pnpm validate` (= `typecheck && lint && test && build`); mirrors `.github/workflows/ci.yml`.
- Workflow roles: `.github/agents/*.agent.md` (design, developer, reviewer). Operational quick-reference: the
  `whetstone-engineering` skill in `.github/skills/`.
