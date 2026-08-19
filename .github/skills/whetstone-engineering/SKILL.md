---
name: whetstone-engineering
description: >-
    Operational engineering playbook for designing and implementing whetstone issues and pull
    requests: monorepo layout, tech stack, design/testability rules, the `pnpm validate` gate,
    and PR conventions. Use whenever shaping or writing code in the whetstone repository.
user-invocable: true
---

# Whetstone engineering playbook

This is the operational quick reference for designing and building whetstone work.
`PRODUCT.md` (product/design memory) and `GUIDELINES.md` (engineering and delivery authority)
are the source of truth. This skill summarizes what the single delivery agent needs in order to act;
it never overrides those documents.

## Repository map

- `src/apps/web/` — React + Vite PWA client.
- `src/apps/server/` — Fastify API server.
- `src/packages/domain/` — pure Entry/link/block/template/note-anchor logic (no React, Fastify, DB, or fs).
- `src/packages/contracts/` — shared API schemas and DTOs (Zod).
- Content is represented by stable **Block rows** in PostgreSQL via Drizzle. Every imported or
  authored format ends as the same **ProseMirror/Tiptap document node** + plaintext hierarchy (legacy
  mdast superseded, `docs/DECISIONS.md` D1); the existing Reader never branches by source format.
  PDF's structured adapter maps validated DoclingDocument items directly to canonical blocks, with
  page geometry/confidence retained only as evidence. The product targets at least 95% usable
  automatic PDF ingestion; administrators correct the remainder in the shared rich editor without
  changing immutable source provenance. Markdown, EPUB, PDF, and converter artifacts remain
  import/export/provenance formats. PostgreSQL stores works, reading units, blocks, templates, notes,
  links, and search indexes.

Organize by feature first. Do not add `src/apps/mobile/` or `src/apps/desktop/` until an issue scopes it.

For where a specific subsystem or file currently lives, read `docs/MAP.md` (the navigational index);
this skill stays high-level. Read the constitution and the map, then the one feature slice — do not
linear-read the repository. Keep your live context bounded for the whole run: run the gate quietly
and read only failures, and delegate bulky or exploratory reading to a subagent that returns
conclusions — a runaway context is the main reason a run gets slow.

## Tech stack (v0)

React + Vite, Fastify, PostgreSQL + Drizzle, Zod, Vitest. Do not add a runtime dependency unless
the issue needs it and the PR explains why.

## Design rules the delivery self-check enforces

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

Before opening or updating a PR, fetch `origin/main` and run the changed-scope handoff gate:

```
pnpm validate:changed   # typecheck, lint, changed-source 100% coverage, build, size, smoke
```

Run the issue's named E2E spec separately. On Windows workers, use `validate.ps1 -Changed`; it writes
the full log under `.agent-logs/`. Exact-head CI is the sole exhaustive gate and must pass every
required lane (quality coverage, runtime/E2E, and isolated contracts) before merge. `pnpm validate`
composes those lanes sequentially for an optional full local run. Never lower coverage thresholds or
skip evidence to make a handoff pass.

Do the landability, acceptance-to-evidence, and gate-by-gate self-check yourself. Do not delegate a
second model review; exact-head CI is the independent merge authority.

## Pull request conventions

- Keep the PR scoped to one issue; no unrelated refactors, dependencies, or scaffolding.
- Prefer cohesive vertical slices (schema + API + server + UI for one capability is fine).
- Open with `Closes #<issue-number>`. The PR body must state: linked issue, what changed, what
  validation ran, and any validation that could not run and why.
- The developer never merges by hand. It applies `merge-ready` after the self-check; a deterministic
  step (`scripts/delivery/mergeReadyPrs.mjs`) merges only when the `GUIDELINES.md` gates pass.
- If your PR changes what an area owns, its entry points, or where a subsystem lives, update
  `docs/MAP.md` (or the relevant `AGENTS.md`) in the same PR — a concise pointer-level edit, not a
  change log. A PR that does not change an area's shape touches no doc.
