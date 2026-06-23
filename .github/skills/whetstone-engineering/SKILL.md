---
name: whetstone-engineering
description: >-
    Operational engineering playbook for implementing or reviewing whetstone issues and pull
    requests: monorepo layout, tech stack, the design/testability rules reviewers enforce, the
    `pnpm validate` gate, and PR conventions. Use whenever writing code, fixing review feedback,
    or reviewing a pull request in the whetstone repository.
user-invocable: true
---

# Whetstone engineering playbook

This is the operational quick reference for building and reviewing whetstone work.
`PRODUCT.md` (product/design memory) and `GUIDELINES.md` (engineering and review authority)
are the source of truth — read them for full detail. This skill summarizes what a coding or
review subagent needs in order to act; it never overrides those documents.

## Repository map

- `src/apps/web/` — React + Vite PWA client.
- `src/apps/server/` — Fastify API server.
- `src/packages/domain/` — pure Entry/link/block/template/note-anchor logic (no React, Fastify, DB, or fs).
- `src/packages/contracts/` — shared API schemas and DTOs (Zod).
- Content is stored as **Block rows** in PostgreSQL via Drizzle (mdast JSON + plaintext per block),
  not as files. Markdown and EPUB are import/export formats; an uploaded source file is kept on disk
  for provenance only. PostgreSQL stores works, reading units, blocks, templates, notes, links, and
  search indexes.

Organize by feature first. Do not add `src/apps/mobile/` or `src/apps/desktop/` until an issue scopes it.

For where a specific subsystem or file currently lives, read `docs/MAP.md` (the navigational index);
this skill stays high-level. Read the constitution and the map, then the one feature slice — do not
linear-read the repository. Keep your live context bounded for the whole run: run the gate quietly
and read only failures, and delegate bulky or exploratory reading to a subagent that returns
conclusions — a runaway context is the main reason a run gets slow.

## Tech stack (v0)

React + Vite, Fastify, PostgreSQL + Drizzle, Zod, Vitest. Do not add a runtime dependency unless
the issue needs it and the PR explains why.

## Design rules reviewers enforce

1. Export the smallest API a consumer needs; keep everything else local.
2. Never expose mutable internals (arrays, maps, caches, state).
3. One product reason to change per module/feature file.
4. Cross-feature and client/server boundaries go through `domain` or `contracts`.
5. Prefer pure functions and composition over inheritance; use discriminated unions for polymorphism.
6. Depend inward: `domain` never imports UI, server, DB, fs, or env config.
7. Validate external input once at the boundary (Zod), then trust typed data inward.
8. Reach important behavior through pure functions or command/query/API boundaries — no fake
   abstractions, DI containers, or interfaces added only for tests.

## Testability and tests

- Put pure product logic in `src/packages/domain` so it tests without React, Fastify, PostgreSQL, or fs.
- Keep Fastify handlers thin, keep file ingestion and provenance-file access behind the server file
  boundary, and keep block and note-anchor creation out of React components so each is testable in
  isolation.
- Target 100% coverage (statements, branches, functions, lines) for included source. Any exclusion
  must be narrow, commented, and justified in the PR. Do not lower thresholds or add assertion-free
  tests to inflate coverage.
- Test the risky parts first: domain logic, Markdown/EPUB parsing into blocks, template
  validation/rendering, block and note-anchor creation, upload path-traversal prevention, and server
  command/query writes.

## Validate before marking work ready

Run the full gate, which mirrors CI (`.github/workflows/ci.yml`):

```
pnpm validate   # = pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

On Windows workers, prefer the bundled `validate.ps1` in this skill directory: it runs `pnpm validate`
encoding-safely, writes the full log under `.agent-logs/`, and prints PASS/FAIL with the tail.
Never lower coverage thresholds or skip steps to make validation pass.

## Pull request conventions

- Keep the PR scoped to one issue; no unrelated refactors, dependencies, or scaffolding.
- Prefer cohesive vertical slices (schema + API + server + UI for one capability is fine).
- Open with `Closes #<issue-number>`. The PR body must state: linked issue, what changed, what
  validation ran, and any validation that could not run and why.
- Developers do not merge. Reviewers merge only when the `GUIDELINES.md` merge gates pass.
- If your PR changes what an area owns, its entry points, or where a subsystem lives, update
  `docs/MAP.md` (or the relevant `AGENTS.md`) in the same PR — a concise pointer-level edit, not a
  change log. A PR that does not change an area's shape touches no doc.
