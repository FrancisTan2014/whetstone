# Engineering guide

This document is the engineering contract for whetstone. It exists so agents do not pattern-match arbitrary TypeScript app structures.

## Architecture style

Use a **feature-first modular monolith**, not a traditional layer-first project.

Do not organize the app primarily as:

```text
controllers/
services/
repositories/
models/
utils/
```

Those folders hide product responsibilities and encourage generic code. Instead, organize by product capability, with small local files inside each feature.

## Monorepo shape

Default v0 shape:

```text
apps/
  web/        # React/Vite PWA client
  server/     # Fastify API server
  desktop/    # Tauri wrapper when desktop packaging starts
packages/
  domain/     # pure Entry/link/template/note-anchor logic
  contracts/  # shared API schemas and DTOs
```

Do not add `apps/mobile/` until a mobile wrapper issue exists. Capacitor is the intended mobile target, but not first scaffolding unless explicitly scoped.

## Package manager and baseline tooling

Use a TypeScript monorepo with:

- `pnpm` workspaces.
- strict TypeScript.
- ESLint.
- Prettier.
- Vitest for unit tests.
- GitHub Actions CI running install, typecheck, lint, test, and build once those commands exist.

Keep root scripts stable:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Dependency choices

Default v0 choices:

- Client: React + Vite.
- API: Fastify.
- Database: PostgreSQL.
- Database access/migrations: Drizzle.
- Runtime validation: Zod.
- Tests: Vitest.

Do not add a runtime dependency unless the issue needs it and the PR explains why. Prefer established OSS libraries for text selection, annotation, and Markdown rendering when those issues arrive.

## Feature-first file organization

Client feature example:

```text
apps/web/src/features/reader/
  ReaderPage.tsx
  ReaderContent.tsx
  selectionAnchor.ts
  readerApi.ts
  readerTypes.ts
  reader.test.ts
```

Server feature example:

```text
apps/server/src/features/entries/
  entryRoutes.ts
  entrySchemas.ts
  entryQueries.ts
  entryCommands.ts
  entryStorage.ts
  entry.test.ts
```

Shared domain example:

```text
packages/domain/src/
  entry.ts
  links.ts
  noteAnchor.ts
  templates.ts
```

Rules:

- Feature folders may contain UI, route, schema, command/query, and storage files for that feature.
- Cross-feature reusable UI lives in `apps/web/src/shared/ui/`.
- Cross-feature client API helpers live in `apps/web/src/shared/api/`.
- Server infrastructure lives in `apps/server/src/db/`, `apps/server/src/files/`, `apps/server/src/config/`, and `apps/server/src/http/`.
- Pure product rules live in `packages/domain`.
- Request/response schemas live in `packages/contracts`.

## Dependency direction

Allowed:

- `apps/web` depends on `packages/domain` and `packages/contracts`.
- `apps/server` depends on `packages/domain` and `packages/contracts`.
- `packages/contracts` may depend on `packages/domain` only when needed.
- `packages/domain` depends on no app, database, web, filesystem, or framework package.

Forbidden:

- `packages/domain` importing React, Fastify, Drizzle, filesystem APIs, or environment config.
- Client importing server internals.
- Server importing client internals.
- Feature code reaching directly into another feature's private files. Share through `packages/domain`, `packages/contracts`, or an explicit shared module.

## Server boundaries

Fastify routes should stay thin:

1. Validate request.
2. Call feature command/query.
3. Return typed response.

Do not put database queries, filesystem path handling, or Markdown parsing directly in route handlers.

Use a central server config module. Do not read `process.env` throughout feature code.

Use a central error handler. Do not add broad catches that hide failures.

## Database rules

- Drizzle schema is the database contract.
- Migrations are committed.
- Multi-step writes that must stay consistent use transactions.
- Link types, work types, and template field types are constrained.
- JSON columns are allowed for designed flexible shapes only: `fields_json` and `answers_json`.
- JSON is validated with Zod at boundaries.

## Markdown file storage

All Markdown file access goes through one server filesystem boundary, such as:

```text
apps/server/src/files/markdownStore.ts
```

Rules:

- Markdown files live under the configured server data directory.
- Server code generates file paths.
- User input is never used directly as a path.
- Normalize and verify paths cannot escape the data directory.
- Prefer write-temp-then-rename for content writes.
- Keep database metadata and file writes consistent; return explicit failure if consistency cannot be preserved.

## Entry/link model

The Entry/link model is core. Do not bypass it for convenience.

- Materials are entries.
- Reading units are entries.
- Notes are entries.
- Relationships are typed links.
- v0 link types: `contains`, `annotates`, `references`, `related_to`.

Do not create note-only tables or material-only structures that prevent notes/materials from participating in future links.

## Templates and notes

- Templates are seeded database rows.
- UI reads template definitions from the API/database path.
- UI must not hard-code template fields except as seed data or tests.
- `fields_json` supports only `short_text` and `long_text` in v0.
- Note answers are stored as `answers_json`, keyed by field id.
- Rendered Markdown is derived output, not the only source of note data.

## UI rules

- Reader is continuous vertical scroll with subtle headings.
- Note editor opens as side panel on desktop-width screens and bottom sheet on narrow screens.
- Selection handling must produce deterministic anchors.
- User/server Markdown must be rendered safely.
- Critical actions must be keyboard usable.

## Naming

Avoid vague names:

- No `*Manager`.
- No `*Helper`.
- Avoid generic `service.ts` when a more precise name exists.

Prefer names that say what the code does:

- `createReadingUnit`
- `writeMarkdownFile`
- `buildNoteAnchor`
- `renderTemplateMarkdown`
- `listWorksForAuthor`

## Tests

Test the risky parts first:

- Domain logic in `packages/domain`.
- Template validation/rendering.
- Note-anchor creation.
- Path traversal prevention in Markdown storage.
- Server command/query behavior for Entry/link writes.
- Reader selection logic when implemented.

Avoid brittle tests that only assert component markup structure unless the issue is specifically UI rendering.

## Pull request expectations

Every PR must state:

- linked issue,
- what changed,
- what validation ran,
- any validation that could not run and why.

Prefer small PRs. If a PR mixes scaffolding, schema, API, and UI behavior without an issue explicitly requiring that vertical slice, request a split.
