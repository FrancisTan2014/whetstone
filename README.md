# whetstone

A private, deterministic personal learning assistant for reading, recitation, Memory, diary, and
writing. The learner chooses what matters; Whetstone remembers, schedules, presents, and records it.
The complete daily loop works without an AI provider.

To run the app and walk through the current Library → Reader → Notes/Memory flow, see the
[quick start guide](./docs/QUICK_START.md). The current product contract and recitation-first delivery
order live in [PRODUCT.md](./PRODUCT.md).

## Monorepo layout

```text
src/
  apps/
    web/       React + Vite PWA client
    server/    Fastify API server
  packages/
    domain/    Pure product logic (Entries, anchors, FSRS, recitation)
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

Before opening or updating a pull request, run the changed-scope handoff gate and the issue's named
E2E spec:

```powershell
pnpm validate:changed
```

The changed gate runs typecheck, lint, related tests with 100% coverage on changed production source,
build, the bundle budget, and smoke. Exact-head CI is the exhaustive merge authority; `pnpm validate`
remains available for an optional full local run.

`pnpm test` runs the exhaustive test suites and enforces 100% statements, branches, functions, and
lines for included app/package source. Generated output, config files, type-only files, test files,
and framework bootstraps are excluded.

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
- **wink-lemmatizer** — English morphological lemmatizer ([`wink-lemmatizer`](https://www.npmjs.com/package/wink-lemmatizer)), MIT-licensed.
- **Wiktionary** — the free dictionary, via the community [Free Dictionary API](https://dictionaryapi.dev/); content licensed **CC BY-SA**.
- **CC-CEDICT** — the community Chinese–English dictionary ([cc-cedict.org](https://cc-cedict.org/)); licensed **CC BY-SA**.

Thanks to these projects and their contributors.

## Development workflow

This repo is built by a **manually-triggered** Copilot CLI delivery agent. You (the maintainer)
decide what runs and when; the agent owns one unit from design through a merge-ready PR, then stops.

1. Give the developer agent an idea or a ready issue; it stabilizes design and creates/refines the issue.
2. The same agent implements and validates that issue end to end on a clean branch.
3. It marks the PR `merge-ready`; deterministic CI gates the merge.

Role definitions live in [.github/agents/](./.github/agents/).
Current design lives in [PRODUCT.md](./PRODUCT.md).
Engineering and delivery rules live in [GUIDELINES.md](./GUIDELINES.md).

## Local launchers

```powershell
.\scripts\run-developer.cmd 12      # one-shot: deliver issue #12; omit the number to fix CI, merge a ready PR, or take the next ready issue
.\scripts\run-developer-auto.cmd    # auto: deterministic supervisor — fresh one-shot delivery agent per real unit; idle polling uses no model
.\scripts\run-tester.cmd            # one-shot: explore the booted app on main beyond the E2E smoke and file high-signal, de-duplicated [Bug]s (or nothing)
.\scripts\run-tester-auto.cmd       # auto: foreground loop — the Tester (QA) schedules itself, explores one session per tick + files bugs, until you stop it (Ctrl+C)
```

The developer runs as a **one-shot** delivery or under the deterministic **foreground supervisor**.
The supervisor polls GitHub without a model, blocks while a worker runs, and launches every
implementation or CI fix in a fresh Copilot process. It also invokes deterministic merge and
dependency-unblock steps. No timer tick enters an active worker's context; Ctrl+C stops the
supervisor. Developer workers use GPT-5.6 Sol with high reasoning effort.

The **Tester (QA)** is the exploratory discovery layer above the deterministic E2E gate
([GUIDELINES.md](./GUIDELINES.md) "Functional verification"). It runs **independently** of delivery,
boots the real stack on `main`, drives the app
beyond the scripted smoke, and files high-signal, de-duplicated `[Bug]` issues — its only action is
filing issues (read-only on code; it never merges or edits). It is **self-limiting**:
`scripts/delivery/testerNextAction.mjs` caps how many bugs a run may file from the open-bug backlog headroom,
and it files **nothing** when it finds nothing. The developer's bug-first selection then pays those
bugs down before new feature work.
