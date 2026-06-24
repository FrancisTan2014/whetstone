# whetstone

A simple personal reading app, starting from a sharp v0:

1. Admin pages input source reading materials.
2. Reader pages display materials.
3. Users click or tap words/phrases to create notes linked to the source text.

The v0 admin, reader, and note-capture flows are implemented. To run the app and walk through the
first author → work → reader → note flow, see the [quick start guide](./docs/QUICK_START.md).

## Monorepo layout

```text
src/
  apps/
    web/       React + Vite PWA client (library admin, reader, note capture)
    server/    Fastify API server (library, content, notes, /health)
  packages/
    domain/    Pure Entry/link/block/template/note-anchor logic
    contracts/ Shared API schemas and DTOs (Zod)
```

The workspace uses pnpm, strict TypeScript, ESLint, Prettier, Vitest, and 100% coverage thresholds for included source files.

## Local development

For the full run-and-use walkthrough, see the [quick start guide](./docs/QUICK_START.md). The
essentials:

Install dependencies:

```powershell
pnpm install
```

Run the web app:

```powershell
pnpm --filter @whetstone/web dev
```

Filtered app build/dev scripts compile referenced workspace packages first, so they work after a
fresh install without running the full workspace build.

Build the web app:

```powershell
pnpm --filter @whetstone/web build
```

Build and start the server:

```powershell
pnpm --filter @whetstone/server build
pnpm --filter @whetstone/server start
```

The server exposes a health check alongside the library, content, and notes APIs:

```text
GET /health
```

## Validation commands

Run these commands before opening a pull request:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test` runs Vitest with coverage and enforces 100% statements, branches, functions, and lines for included app/package source. Generated output, config files, type-only files, test files, and framework bootstraps are excluded.

## Development workflow

This repo is built by **manually-triggered** Copilot CLI roles. You (the maintainer) act as the
coordinator: you decide what runs and when, and each role does one unit of work and then stops.

1. Stabilize a requirement, then create a GitHub issue with acceptance criteria (the design role helps).
2. Trigger the developer role to implement one ready issue end to end on a clean branch and open a PR.
3. Trigger the reviewer role to review that PR and merge it when the gates pass.

Role definitions live in [.github/agents/](./.github/agents/).
Current design lives in [PRODUCT.md](./PRODUCT.md).
Engineering and review rules live in [GUIDELINES.md](./GUIDELINES.md).

## Local launchers

```powershell
.\scripts\run-design.cmd            # shape ideas into PRODUCT.md + issues (interactive)
.\scripts\run-developer.cmd 12      # implement issue #12 (omit the number to pick the next ready issue: lowest-numbered, dependencies closed)
.\scripts\run-reviewer.cmd 17       # review PR #17 (omit the number to pick the oldest needs-review PR)
```

There is no scheduled or background automation; you trigger each role yourself, one at a time.
