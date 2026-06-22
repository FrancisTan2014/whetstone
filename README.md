# whetstone

A simple personal reading app, starting from a sharp v0:

1. Admin pages input source reading materials.
2. Reader pages display materials.
3. Users click or tap words/phrases to create notes linked to the source text.

This repository currently contains the TypeScript monorepo foundation only. User-facing admin, reader, and note features are intentionally deferred to later issues.

## Monorepo layout

```text
apps/
  web/       React + Vite placeholder app
  server/    Fastify API server with /health
packages/
  domain/    Pure domain placeholder exports
  contracts/ Shared API contract placeholder exports
```

The workspace uses pnpm, strict TypeScript, ESLint, Prettier, Vitest, and 100% coverage thresholds for included source files.

## Local development

Install dependencies:

```powershell
pnpm install
```

Run the placeholder web app:

```powershell
pnpm --filter @whetstone/web dev
```

Filtered app build/dev scripts compile referenced workspace packages first, so they work after a
fresh install without running the full workspace build.

Build the placeholder web app:

```powershell
pnpm --filter @whetstone/web build
```

Build and start the placeholder server:

```powershell
pnpm --filter @whetstone/server build
pnpm --filter @whetstone/server start
```

The server exposes:

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

1. Stabilize a requirement in discussion.
2. Create a GitHub issue with acceptance criteria.
3. Let the scheduled local Copilot developer session claim the issue, delegate implementation to a subagent when available, and open a PR.
4. Let the scheduled local Copilot reviewer session delegate detailed review to a subagent when available and post PR feedback.
5. Iterate, then merge when ready.

See [docs/LOCAL_AGENT_WORKFLOW.md](./docs/LOCAL_AGENT_WORKFLOW.md).
Current design lives in [PRODUCT.md](./PRODUCT.md).
Engineering and review rules live in [GUIDELINES.md](./GUIDELINES.md).

## Local launchers

```powershell
.\scripts\start-design.cmd
.\scripts\start-coordinator.cmd
.\scripts\start-developer.cmd
.\scripts\start-reviewer.cmd
```

Start scheduled Copilot sessions:

```powershell
.\scripts\start-coordinator.cmd
```

The developer and reviewer scripts are one-shot helpers. The coordinator is the only scheduled role.
