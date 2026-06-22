# Whetstone Guidelines

This is the single durable engineering and review guide for whetstone. It exists so agents do not pattern-match arbitrary TypeScript app structures or rely on generic LLM review instincts.

These guidelines are inspired by practical TypeScript style guides such as the Google TypeScript Style Guide, then adapted to whetstone's product, stack, and local-agent workflow. When a rule here conflicts with a generic external style guide, this file wins for this repository.

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

## Design principles

The goal is not to recite SOLID as an acronym. The goal is to make code hard to misuse and easy to change. In whetstone, the practical principles are:

1. **Expose as little as possible.** A module should export the smallest API that another module needs. Everything else stays local.
2. **Do not expose mutable internals.** If callers can mutate a module's arrays, maps, objects, caches, or state, bugs can be born outside the owning module.
3. **Keep responsibilities cohesive.** A feature file or module should have one product reason to change.
4. **Make boundaries explicit.** Cross-feature and client/server interactions go through `packages/domain`, `packages/contracts`, or an explicitly named shared module.
5. **Prefer composition and pure functions over inheritance.** Most v0 logic should be data + functions, not class hierarchies.
6. **Depend inward.** Domain logic does not depend on UI, server, database, filesystem, or environment config.
7. **Validate at boundaries, trust inside.** External input is validated once at the boundary, then passed inward as typed data.
8. **Design for testability through boundaries.** Important behavior should be reachable through pure functions, feature commands/queries, or API boundaries. Do not add fake abstractions only for tests.

Practical SOLID mapping for this project:

- **Single responsibility** -> one module has one product/technical reason to change. `buildNoteAnchor` should not also save notes or update React state.
- **Open/closed** -> prefer data-driven extension points already in the design, such as DB-backed templates and typed links. Do not add abstract base classes or speculative plugin systems.
- **Liskov substitution** -> avoid inheritance in v0. If a polymorphic shape is needed, prefer discriminated unions and exhaustive handling.
- **Interface segregation** -> keep contracts small. Do not create broad interfaces with methods consumers do not use.
- **Dependency inversion** -> keep pure domain code independent. Infrastructure depends on domain/contracts; domain does not depend on infrastructure. Do not create interfaces merely to satisfy the acronym.

Reviewers should enforce these concrete rules, not generic SOLID phrasing.

## TypeScript source style

Formatting is handled by Prettier. Do not debate formatting in review unless generated formatting is not applied.

Rules:

- Source files are UTF-8.
- Use ES modules. Do not use TypeScript `namespace`, triple-slash references, or CommonJS `require`.
- Prefer named exports. Do not use default exports for app/domain code.
- Use `import type` / `export type` for type-only imports/exports when appropriate.
- Use `const` by default. Use `let` only when reassignment is required. Do not use `var`.
- Use one variable per declaration.
- Do not use mutable exports such as `export let`.
- Do not create static container classes only for namespacing. Use module-level named exports.
- Avoid barrel files until there is a clear package boundary need; they can hide dependency direction and create accidental cycles.
- Keep exported module API small. If a symbol is only used inside a feature folder, do not export it outside that folder.
- Do not export internal state objects. Export functions that perform intended operations or return immutable snapshots.

## Type design

Use TypeScript's type system to encode domain constraints.

Rules:

- Prefer precise literal unions for closed sets such as `WorkType`, `EntryType`, `LinkType`, and template field types.
- Prefer `interface` for object shapes that model externally implemented contracts; prefer `type` for unions, branded ids, mapped types, and composed readonly values.
- Use branded string types for ids when practical, e.g. `EntryId`, `WorkId`, `TemplateId`, to avoid mixing ids accidentally.
- Prefer `unknown` over `any` at external boundaries, then validate/narrow with Zod or explicit guards.
- Optional values should normally be `undefined`, not `null`, unless PostgreSQL/API semantics require `null`.
- Do not use boolean parameter traps for public functions. Prefer option objects with named fields.
- Do not widen domain strings to `string` after validation. Preserve the narrowed domain type.
- DTO types crossing client/server boundaries must be defined in `packages/contracts` or generated from contract schemas.

## Naming and file names

Use names that communicate product responsibility.

Rules:

- File and folder names use `camelCase` or established framework conventions (`ReaderPage.tsx` is acceptable for React components).
- React component files use `PascalCase.tsx`.
- Types, interfaces, and React components use `PascalCase`.
- Functions, variables, and object properties use `camelCase`.
- Constants use `camelCase` unless they are true compile-time constants with no domain-specific identity. Avoid noisy `UPPER_CASE` by default.
- Avoid `data`, `info`, `item`, `obj`, `handler`, `manager`, `helper`, and `service` when a domain name is available.

Prefer:

```ts
createReadingUnit
writeMarkdownFile
buildNoteAnchor
renderTemplateMarkdown
listWorksForAuthor
```

Avoid:

```ts
processData
handleSubmit
entryManager
markdownHelper
noteService
```

## Comments and documentation

Code should be readable through names and structure first.

Rules:

- Comments explain why, not what.
- Public exported functions in `packages/domain` and `packages/contracts` should have short comments when their behavior is not obvious from the name and type.
- Do not add noisy JSDoc to every function.
- If a workaround is required for a library/platform quirk, comment with the reason and a link when useful.
- Review comments should cite `PRODUCT.md`, this file, the issue acceptance criteria, or a concrete failing behavior.

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

## State and immutability

Prefer immutable data and explicit state transitions.

Rules:

- Domain objects should be plain immutable values where practical.
- Use `readonly` properties and `ReadonlyArray<T>` for shared/domain data that should not be mutated by callers.
- Do not expose internal mutable collections from classes/modules. Return readonly views or copies.
- Do not expose mutable references to module-owned state, even if the current caller promises not to mutate them.
- Do not mutate function arguments unless the function name and type make mutation explicit.
- Prefer pure functions in `packages/domain`: input value -> output value, no hidden state.
- React state updates must be immutable. Do not mutate arrays/objects in place and then reuse the same reference.
- Server request state must be request-scoped. Do not store request/user data in module-level mutable variables.
- Caches, if introduced later, must have explicit ownership, invalidation rules, and tests. Do not add hidden mutable caches opportunistically.
- Database rows and DTOs crossing module boundaries should be treated as values. If a module must enrich or transform them, create a new object.

Examples:

```ts
// Good
export type Entry = Readonly<{
  id: EntryId;
  type: EntryType;
  links: ReadonlyArray<EntryLink>;
}>;

export function addLink(entry: Entry, link: EntryLink): Entry {
  return { ...entry, links: [...entry.links, link] };
}

// Bad: caller can mutate internal state
export function getLinks(): EntryLink[] {
  return links;
}

// Better: caller receives an immutable snapshot
export function getLinks(): ReadonlyArray<EntryLink> {
  return [...links];
}
```

## Server boundaries

Fastify routes should stay thin:

1. Validate request.
2. Call feature command/query.
3. Return typed response.

Do not put database queries, filesystem path handling, or Markdown parsing directly in route handlers.

Use a central server config module. Do not read `process.env` throughout feature code.

Use a central error handler. Do not add broad catches that hide failures.

## Testability

Test-friendly code is a worthy concern when it comes from good design boundaries.

Rules:

- Put pure product logic in `packages/domain` so it can be tested without React, Fastify, PostgreSQL, or filesystem setup.
- Put server use cases in feature command/query functions that can be tested with explicit dependencies.
- Keep Fastify route handlers thin so API behavior can be tested at route level and domain behavior can be tested separately.
- Keep Markdown filesystem access behind the server file boundary so path safety and failure cases can be tested directly.
- Keep note-anchor creation separate from React components so text-range behavior can be tested without a browser when possible.
- Prefer dependency parameters for real infrastructure boundaries such as database clients, file stores, clocks, and id generators when a test needs control.
- Do not create interfaces, factories, or dependency injection containers merely to make tests easier.
- Do not make private/internal module state public for tests. Test through public behavior, or extract pure logic into a module with a real product reason to exist.
- If behavior is hard to test, first ask whether the module has too many responsibilities or is hiding an important boundary.

## Logging

Use structured logging. Fastify's Pino logger is the default server logger.

Rules:

- Do not use raw `console.log` / `console.error` in application code. Use the request logger or an injected/central logger.
- Every server request should have a request id/correlation id.
- Log events, not prose paragraphs. Prefer stable fields such as `entryId`, `workId`, `readingUnitId`, `templateId`, `linkType`, `route`, and `durationMs`.
- Do not log secrets, tokens, passwords, full Markdown content, note bodies, selected text snapshots, or user-authored answers.
- For expected validation failures, return typed errors and log at `debug` or not at all unless useful.
- For operational failures, log at `error` with safe context and the exception.
- Client logging is for development diagnostics only in v0. Do not add client telemetry/analytics.
- If a PR adds a new failure mode around database writes, Markdown file writes, or note-anchor creation, add a useful server log at the boundary where the failure is handled.

Recommended levels:

- `debug`: development-only flow details.
- `info`: server start/stop and successful administrative mutations when useful.
- `warn`: recoverable operational issues.
- `error`: failed operations requiring attention.

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

Agent-built code should target **100% coverage for source code**. Maintaining tests is cheap for agents, and coverage is a useful guard against hallucinated behavior.

Coverage rules:

- CI should enforce 100% statements, branches, functions, and lines for app/package source once test tooling exists.
- Exclude generated files, migration files, framework bootstrap files, type-only files, test files, and configuration files from coverage.
- Do not lower thresholds to make a PR pass.
- Do not add shallow tests that execute code without assertions just to increase coverage.
- Do not rely on snapshots as the only test for behavior.
- If a line is truly untestable, refactor toward a testable boundary before considering an exclusion.
- Any coverage exclusion must be narrow, commented, and justified in the PR.

Test the risky parts first:

- Domain logic in `packages/domain`.
- Template validation/rendering.
- Note-anchor creation.
- Path traversal prevention in Markdown storage.
- Server command/query behavior for Entry/link writes.
- Reader selection logic when implemented.

Avoid brittle tests that only assert component markup structure unless the issue is specifically UI rendering.

Testing should validate behavior and invariants, not implementation trivia. Prefer a few meaningful tests over broad shallow snapshots.

## Pull request expectations

Every PR must state:

- linked issue,
- what changed,
- what validation ran,
- any validation that could not run and why.

Prefer cohesive vertical feature/fix PRs. A PR may include schema, API, server logic, and UI when those changes are all required to deliver one user-visible capability or one coherent fix. Request a split only when the PR mixes unrelated outcomes, unrelated refactors, or broad scaffolding with feature behavior.

## Review gates

Reviewer agents enforce this same spec. Review comments should be high-signal: only material issues that affect correctness, safety, maintainability, product fit, or validation.

### Issue fit

- PR links an issue with `Closes #...` or clearly references the issue.
- The linked issue has outcome, acceptance criteria, constraints/non-goals, and validation.
- The PR satisfies all acceptance criteria.
- The PR does not implement requirements outside the linked issue.
- Do not request a split merely because the PR touches schema, API, server logic, and UI. Vertical feature/fix PRs are expected.
- If the issue mixes unrelated outcomes or broad scaffolding with feature behavior, comment that future work must be split by coherent user capability or engineering concern.

### Product/design fit

- Behavior matches `PRODUCT.md`.
- No older/deferred complexity is reintroduced unless the issue explicitly asked for it.
- v0 stays focused on admin content input, continuous reader, selected text note capture, Entry/link model, and DB-backed note templates.
- No hidden feature creep: no spaced repetition, memorization scheduling, AI grading, voice, ebook parsing, telemetry, or complicated settings in v0.

### Architecture fit

- Implementation follows this spec.
- Project structure is feature-first, not traditional layer-first.
- Module APIs expose the smallest useful surface and do not leak internal mutable state.
- Web-core TypeScript direction is preserved.
- Server-centered source of truth is preserved.
- Server stores Markdown files under a data directory; PostgreSQL stores metadata, paths, indexes, templates, notes, and links.
- Entry/link model is preserved; notes are entries, not ad-hoc child records that cannot participate in future links.
- Templates are read from database seed data, not hard-coded in UI components.
- Shared domain rules live in `packages/domain`; shared API contracts live in `packages/contracts`.
- Server routes stay thin and delegate to feature command/query/storage modules.

### TypeScript and state quality

- `strict` TypeScript stays enabled for every package.
- No `any` unless the PR gives a narrow reason at a true external boundary. Prefer `unknown` plus validation.
- No `// @ts-ignore` or `// @ts-expect-error` unless the issue explicitly requires interop and the comment names the reason.
- No unsafe non-null assertions (`!`) where a real guard or schema validation is possible.
- Public functions, API handlers, and shared types have explicit parameter and return types.
- Union/domain values use typed constants or literal unions, not scattered strings.
- Public/domain objects that should be stable use `readonly` properties or immutable value types.
- Public APIs do not expose internal mutable arrays, maps, sets, or objects that callers can mutate.
- Modules do not export mutable state objects or broad grab-bag APIs.
- Functions do not mutate arguments unless mutation is explicit in the name, type, and issue scope.
- React state is updated immutably; no in-place mutation followed by setting the same reference.
- Module-level mutable state is not used for request/user/session data.
- Hidden caches are not introduced without explicit ownership, invalidation, and tests.

### Testability quality

- Important behavior is reachable through pure functions, feature commands/queries, API boundaries, or UI interactions.
- Code does not expose private mutable state only for tests.
- Code does not introduce fake interfaces, factories, or dependency injection containers only for tests.
- Domain logic can be tested without React, Fastify, PostgreSQL, filesystem, or network setup.
- File/database failure paths introduced by the PR have a practical test or documented validation path.

### Client/UI quality

- UI behavior matches `PRODUCT.md`: continuous reader, subtle headings, selected text note capture, side panel/bottom sheet editor.
- Components are scoped by responsibility; no large page component that owns unrelated admin, reader, and note-editor logic.
- Selection logic is isolated and testable where practical; note anchors are derived deterministically from selected text ranges.
- Rendering user-provided Markdown/text is safe. Do not render raw user/server Markdown as unsanitized HTML.
- Accessibility basics are preserved: form labels, keyboard-usable controls, visible focus, and no click-only critical interaction.
- Responsive behavior is explicit for desktop side panel vs narrow-screen bottom sheet.
- Client does not treat local storage/IndexedDB as source of truth in v0.

### Fastify/API quality

- Every route validates params, query, and body before use.
- API responses have a stable shape; errors are explicit and do not leak stack traces or filesystem paths.
- Route handlers stay thin: parse/validate input, call domain/storage functions, return response.
- No broad catch-all that hides failures. If an error is translated, preserve enough information for logs/debugging.
- Server code does not trust client-provided paths, entry ids, offsets, template ids, or link types without validation.
- API contracts used by client/server stay synchronized through shared types or generated/validated schemas.

### Logging quality

- Server code uses Fastify/Pino structured logging, not raw `console.log` / `console.error`.
- Logs include safe identifiers and operational context when useful.
- Logs do not include secrets, tokens, full Markdown content, note bodies, selected text snapshots, or template answers.
- Errors at database/filesystem/note-anchor boundaries are logged with safe context.
- Client code does not add telemetry/analytics in v0.

### PostgreSQL/data-model quality

- Schema changes are represented by migrations or a documented repeatable setup path.
- Tables have primary keys and needed foreign keys for Entry/link/template relationships.
- Link types are constrained to the current supported set unless the issue explicitly expands them.
- Multi-step writes that must stay consistent use transactions.
- Queries are parameterized; no string-concatenated SQL with user input.
- Indexes exist for lookups introduced by the PR, especially entry links, work reading-unit ordering, template lookup, and note anchors.
- JSON columns are used only for designed flexible shapes (`fields_json`, `answers_json`) and are validated at read/write boundaries.

### Server filesystem Markdown quality

- Markdown file paths are generated or normalized by server code and cannot escape the configured data directory.
- User input is never used directly as a filesystem path.
- Writes are safe against partial files where practical: write temp file then rename, or document why the simpler write is acceptable for v0.
- Database metadata and Markdown file writes stay consistent; if one side fails, the PR handles cleanup or returns an explicit failure.
- File reads/writes are asynchronous.
- File deletion or replacement is scoped to the intended reading unit only.
- Tests or validation cover path traversal attempts when file-write code is added.

### Template/note quality

- Templates are loaded from database seed data, not hard-coded in UI components.
- Template `fields_json` uses only v0 field types: `short_text`, `long_text`.
- `answers_json` is keyed by field id and validated against the template before save/render.
- Rendered Markdown is derived from template + answers; it is not the only source of structured note data.
- Note anchors include reading-unit entry id, start/end offsets, selected text snapshot, and containing paragraph/context snapshot.
- Offsets are stable against the stored Markdown source used to render the reader; if transformations occur, the PR explains the mapping.

### Dependencies and tooling

- New runtime dependencies require clear issue justification.
- Prefer established OSS libraries for text selection/annotation/Markdown only when the issue needs them.
- Lockfile changes match dependency changes and do not include unrelated upgrades.
- Tooling changes preserve strict TypeScript, lint, format, build, and test commands once introduced.

### Validation

- PR body lists the commands run.
- Existing build/lint/test commands pass.
- If validation cannot run because tooling does not exist yet, the PR says so and the issue scope justifies it.
- Behavior changed by the PR has tests when test infrastructure exists.
- Data/file changes include at least one validation path for failure cases, not only happy paths.
- Coverage thresholds remain at 100% for included source files once coverage tooling exists.
- Coverage is meaningful: tests assert behavior/invariants and do not merely execute lines.

### Review output

Use one of:

- **Request changes**: material issue blocks merge. Add label `changes-requested`, remove `needs-review`.
- **Ready for human merge**: no material blockers. Add label `review-approved`, remove `needs-review` and `changes-requested`.

Every review must include marker:

```text
reviewer-run-reviewed: <head-sha>
```
