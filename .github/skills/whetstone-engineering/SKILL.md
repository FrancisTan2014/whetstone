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
- `src/packages/domain/` — pure Entry/link/template/note-anchor logic (no React, Fastify, DB, or fs).
- `src/packages/contracts/` — shared API schemas and DTOs (Zod).
- Markdown source files live on the server filesystem under the configured data directory.
  PostgreSQL (via Drizzle) stores metadata, paths, indexes, templates, notes, and links.

Organize by feature first. Do not add `src/apps/mobile/` or `src/apps/desktop/` until an issue scopes it.

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
- Keep Fastify handlers thin, keep Markdown fs access behind the server file boundary, and keep
  note-anchor creation out of React components so each is testable in isolation.
- Target 100% coverage (statements, branches, functions, lines) for included source. Any exclusion
  must be narrow, commented, and justified in the PR. Do not lower thresholds or add assertion-free
  tests to inflate coverage.
- Test the risky parts first: domain logic, template validation/rendering, note-anchor creation,
  Markdown path-traversal prevention, and server command/query writes.

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
