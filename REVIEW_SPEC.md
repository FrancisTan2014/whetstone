# Review spec

This is the concrete review checklist for whetstone pull requests. The reviewer agent must use this document instead of relying only on generic LLM review instincts.

## Review order

Stop at the first hard blocker if it makes further review noisy. Otherwise leave only material findings.

## 1. Issue fit

- PR links an issue with `Closes #...` or clearly references the issue.
- The linked issue has outcome, acceptance criteria, constraints/non-goals, and validation.
- The PR satisfies all acceptance criteria.
- The PR does not implement requirements outside the linked issue.
- Do not request a split merely because the PR touches schema, API, server logic, and UI. Vertical feature/fix PRs are expected.
- If the issue mixes unrelated outcomes or broad scaffolding with feature behavior, comment that future work must be split by coherent user capability or engineering concern.

## 2. Product/design fit

- Behavior matches `PRODUCT.md`.
- No older/deferred complexity is reintroduced unless the issue explicitly asked for it.
- v0 stays focused on: admin content input, continuous reader, selected text note capture, Entry/link model, DB-backed note templates.
- No hidden feature creep: no spaced repetition, memorization scheduling, AI grading, voice, ebook parsing, or complicated settings in v0.

## 3. Architecture fit

- Implementation follows `ENGINEERING.md`.
- Project structure is feature-first, not traditional layer-first.
- Web-core TypeScript direction is preserved.
- Server-centered source of truth is preserved.
- Server stores Markdown files under a data directory; PostgreSQL stores metadata, paths, indexes, templates, notes, and links.
- Entry/link model is preserved; notes are entries, not ad-hoc child records that cannot participate in future links.
- Note anchors store reading-unit entry id, start/end offsets, selected text snapshot, and containing paragraph/context snapshot.
- Templates are read from DB seed data, not hard-coded in UI components.
- Template definitions use controlled JSON (`fields_json`), and note answers use `answers_json`.
- Shared domain rules live in `packages/domain`; shared API contracts live in `packages/contracts`.
- Server routes stay thin and delegate to feature command/query/storage modules.

## 4. Data safety

- No secrets, tokens, passwords, local machine paths, or personal content are committed.
- File paths for server-side Markdown are normalized and cannot escape the configured data directory.
- User-provided Markdown/text is rendered safely; no unsafe HTML injection.
- Database migrations, seed data, and file writes are deterministic and repeatable.

## 5. TypeScript quality

- `strict` TypeScript stays enabled for every package.
- No `any` unless the PR gives a narrow reason at a true external boundary. Prefer `unknown` plus validation.
- No `// @ts-ignore` or `// @ts-expect-error` unless the issue explicitly requires interop and the comment names the reason.
- No unsafe non-null assertions (`!`) where a real guard or schema validation is possible.
- Public functions, API handlers, and shared types have explicit parameter and return types.
- Union/domain values use typed constants or literal unions, not scattered strings.
- Shared domain types are defined once and reused across client/server where appropriate; no duplicated DTO shapes that can drift.
- Type narrowing happens at boundaries; internal code should not repeatedly re-check the same untrusted shape.

## 6. Client/UI quality

- UI behavior matches `PRODUCT.md`: continuous reader, subtle headings, selected text note capture, side panel/bottom sheet editor.
- Components are scoped by responsibility; no large page component that owns unrelated admin, reader, and note-editor logic.
- Selection logic is isolated and testable where practical; note anchors are derived deterministically from selected text ranges.
- Rendering user-provided Markdown/text is safe. Do not render raw user/server Markdown as unsanitized HTML.
- Accessibility basics are preserved: form labels, keyboard-usable controls, visible focus, and no click-only critical interaction.
- Responsive behavior is explicit for desktop side panel vs narrow-screen bottom sheet.
- Client does not treat local storage/IndexedDB as source of truth in v0.

## 7. Fastify/API quality

- Every route validates params, query, and body before use.
- API responses have a stable shape; errors are explicit and do not leak stack traces or filesystem paths.
- Route handlers stay thin: parse/validate input, call domain/storage functions, return response.
- No broad catch-all that hides failures. If an error is translated, preserve enough information for logs/debugging.
- Server code does not trust client-provided paths, entry ids, offsets, template ids, or link types without validation.
- API contracts used by client/server stay synchronized through shared types or generated/validated schemas.

## 7a. Logging quality

- Server logging follows `ENGINEERING.md`.
- Server code uses Fastify/Pino structured logging, not raw `console.log` / `console.error`.
- Logs include safe identifiers and operational context when useful.
- Logs do not include secrets, tokens, full Markdown content, note bodies, selected text snapshots, or template answers.
- Errors at database/filesystem/note-anchor boundaries are logged with safe context.
- Client code does not add telemetry/analytics in v0.

## 8. PostgreSQL/data-model quality

- Schema changes are represented by migrations or a documented repeatable setup path.
- Tables have primary keys and needed foreign keys for Entry/link/template relationships.
- Link types are constrained to the current supported set unless the issue explicitly expands them.
- Multi-step writes that must stay consistent use transactions.
- Queries are parameterized; no string-concatenated SQL with user input.
- Indexes exist for lookups introduced by the PR, especially entry links, work reading-unit ordering, template lookup, and note anchors.
- JSON columns are used only for designed flexible shapes (`fields_json`, `answers_json`) and are validated at read/write boundaries.

## 9. Server filesystem Markdown quality

- Markdown file paths are generated or normalized by server code and cannot escape the configured data directory.
- User input is never used directly as a filesystem path.
- Writes are safe against partial files where practical: write temp file then rename, or document why the simpler write is acceptable for v0.
- Database metadata and Markdown file writes stay consistent; if one side fails, the PR handles cleanup or returns an explicit failure.
- File reads/writes are asynchronous.
- File deletion or replacement is scoped to the intended reading unit only.
- Tests or validation cover path traversal attempts when file-write code is added.

## 10. Template/note quality

- Templates are loaded from database seed data, not hard-coded in UI components.
- Template `fields_json` uses only v0 field types: `short_text`, `long_text`.
- `answers_json` is keyed by field id and validated against the template before save/render.
- Rendered Markdown is derived from template + answers; it is not the only source of structured note data.
- Note anchors include reading-unit entry id, start/end offsets, selected text snapshot, and containing paragraph/context snapshot.
- Offsets are stable against the stored Markdown source used to render the reader; if transformations occur, the PR explains the mapping.

## 11. General maintainability

- Functions/components are named for their responsibility.
- The PR uses existing patterns in the repo.
- No large speculative abstractions or framework additions outside the issue.
- No broad silent catches or success-shaped fallbacks.
- No hidden global mutable state for request/user data.
- No unrelated formatting churn, mass rewrites, or dependency changes.

## 12. Dependencies and tooling

- New runtime dependencies require clear issue justification.
- Prefer established OSS libraries for text selection/annotation/Markdown only when the issue needs them.
- Lockfile changes match dependency changes and do not include unrelated upgrades.
- Tooling changes preserve strict TypeScript, lint, format, build, and test commands once introduced.

## 13. Validation

- PR body lists the commands run.
- Existing build/lint/test commands pass.
- If validation cannot run because tooling does not exist yet, the PR says so and the issue scope justifies it.
- Behavior changed by the PR has tests when test infrastructure exists.
- Data/file changes include at least one validation path for failure cases, not only happy paths.

## 14. Review output

Use one of:

- **Request changes**: material issue blocks merge. Add label `changes-requested`, remove `needs-review`.
- **Ready for human merge**: no material blockers. Add label `review-approved`, remove `needs-review` and `changes-requested`.

Every review must include marker:

```text
reviewer-run-reviewed: <head-sha>
```
