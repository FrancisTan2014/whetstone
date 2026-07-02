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

## Bundle size budget

`pnpm size-limit` measures the web app's production build (the Vite `dist` JS and CSS, brotli-compressed) against the budgets in [`.size-limit.json`](./.size-limit.json), and CI runs it on every pull request after `pnpm build` — a regression past budget fails the build. Run a build first, then check:

```powershell
pnpm build
pnpm size-limit
```

A failure prints the measured size next to its limit (for example `Size: 280 kB / Size limit: 270 kB`). To fix it, **remove the bloat** — drop or lighten a dependency, or code-split a large chunk. Only **raise a budget** in `.size-limit.json` when the growth is intentional and justified; the budget is a regression tripwire (current baseline plus modest headroom), not a target to grow into. Keep it scoped to the web app — the server/Node packages are not gated.

## Lighthouse report (advisory, non-blocking)

A separate [`Lighthouse (advisory)`](./.github/workflows/lighthouse.yml) workflow runs Lighthouse CI against the built web app on every pull request — collecting 3 runs and reporting the **median** Core Web Vitals / performance scores, with the report uploaded to LHCI temporary-public-storage (the URL is printed in the job log, reachable from the PR's checks). It is **informational only and never blocks merge**: runtime perf is flaky on shared CI runners, so it lives outside the required `quality` job, every Lighthouse assertion is `warn` (see [`.lighthouserc.json`](./.lighthouserc.json)), and both the job and its run step are `continue-on-error`. The deterministic merge gate is the bundle-size budget above; Lighthouse is the runtime signal, not a gate. To run it locally (needs Chrome): `pnpm build` then `pnpm lighthouse`.

## Mutation testing (advisory, non-blocking)

A separate [`Mutation testing (advisory)`](./.github/workflows/mutation.yml) workflow runs [Stryker](https://stryker-mutator.io) **nightly** over the two pure, logic-dense packages `@whetstone/domain` and `@whetstone/contracts` — planting representative bugs (mutants) and reporting which **survive** the tests. It objectively backs the mutation-resistance rule in [`GUIDELINES.md`](./GUIDELINES.md): a surviving mutant is a shallow / happy-path-only test that still hits 100% line coverage. It is **informational only and never blocks merge**: it is not part of `pnpm validate`, and Stryker's `break` threshold is unset (`thresholds.low` is only an advisory baseline floor). The nightly job uploads the HTML report as an artifact. To run it locally:

```powershell
pnpm mutation
```

It reads [`stryker.conf.mjs`](./stryker.conf.mjs) (scoped to domain + contracts; the Vitest runner uses [`vitest.stryker.config.ts`](./vitest.stryker.config.ts) so only those packages' fast tests run) and writes `reports/mutation/mutation.html` — open it to see each surviving mutant and the file/line it lives on, then strengthen the test that should have caught it. Chasing a specific score or an equivalent mutant is a non-goal; the value is surfacing genuinely shallow tests. Server/web are out of scope for v0 (slower, I/O-bound) — extend the `mutate` globs to add a package later.

## Screenshots (manual)

`pnpm screenshots` boots the real stack against an ephemeral in-memory database, ingests the public-domain fixture EPUBs in [`fixtures/epub/`](./fixtures/epub/) through the live pipeline, serves the production web build with `vite preview`, and drives headless Chromium to write a labeled PNG for each stage (Today at the root route plus Library at `#/library` and the Reader, each in Day/Night at desktop and mobile; the selection → note-editor → note-saved annotation moment) into `artifacts/screenshots/` (git-ignored).

It is a screenshot generator, not a test suite, and is **not** part of `pnpm validate` or CI, so it cannot become a flaky merge gate. One-time browser install:

```powershell
pnpm exec playwright install chromium
pnpm screenshots
```

## Acknowledgments

whetstone's in-reader vocabulary lookup is built on open dictionary data, with gratitude:

- **WordNet®** — Princeton University ([wordnet.princeton.edu](https://wordnet.princeton.edu/)), via the
  MIT-licensed [`wordpos`](https://www.npmjs.com/package/wordpos) / [`wordnet-db`](https://www.npmjs.com/package/wordnet-db) packages.
- **Wiktionary** — the free dictionary, via the community [Free Dictionary API](https://dictionaryapi.dev/); content licensed **CC BY-SA**.
- **CC-CEDICT** — the community Chinese–English dictionary ([cc-cedict.org](https://cc-cedict.org/)); licensed **CC BY-SA**.

Thanks to these projects and their contributors.

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
.\scripts\run-developer.cmd 12      # one-shot: implement issue #12 (omit the number to auto-decide: fix an open changes-requested PR, else the next ready issue — ready [Bug]s before [Task]s)
.\scripts\run-developer-auto.cmd    # auto: foreground loop — the developer schedules itself and does one unit per tick until you stop it (Ctrl+C)
.\scripts\run-reviewer.cmd 17       # one-shot: review PR #17 (omit the number to auto-pick the oldest needs-review PR), then run the merge step
.\scripts\run-reviewer-auto.cmd     # auto: foreground loop — the reviewer schedules itself, reviews one PR per tick + runs the merge step, until you stop it (Ctrl+C)
.\scripts\run-tester.cmd            # one-shot: explore the booted app on main beyond the E2E smoke and file high-signal, de-duplicated [Bug]s (or nothing)
.\scripts\run-tester-auto.cmd       # auto: foreground loop — the Tester (QA) schedules itself, explores one session per tick + files bugs, until you stop it (Ctrl+C)
```

The developer and reviewer each run two ways: a **one-shot** run that handles a single unit/PR, or an
`*-auto.cmd` **foreground** loop where the role schedules itself (Copilot's scheduled-task feature) and
does one unit per tick — the developer fixes a sent-back PR or implements the next ready issue; the
reviewer reviews the next `needs-review` PR and runs the deterministic merge step — until you stop it
(Ctrl+C). The design role you trigger yourself.

The **Tester (QA)** is the exploratory discovery layer above the deterministic E2E gate
([GUIDELINES.md](./GUIDELINES.md) "Functional verification"). It runs **independently** of the
reviewer (on a different model than the developer), boots the real stack on `main`, drives the app
beyond the scripted smoke, and files high-signal, de-duplicated `[Bug]` issues — its only action is
filing issues (read-only on code; it never merges or edits). It is **self-limiting**:
`scripts/tester-next-action.mjs` caps how many bugs a run may file from the open-bug backlog headroom,
and it files **nothing** when it finds nothing. The developer's bug-first selection then pays those
bugs down before new feature work.
