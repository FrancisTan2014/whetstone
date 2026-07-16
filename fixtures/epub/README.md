# EPUB fixtures

Small, **public-domain** EPUBs ingested through the live ingestion pipeline. Most are used by the
manual screenshot harness (`scripts/screenshots.mjs`, run via `pnpm screenshots`) so the captured
screenshots show how the app renders real content; `today-cycle.epub` is additionally adopted by the
Today daily-cycle E2E. They are **not** part of the `pnpm validate` gate (the E2E suite runs
separately via Playwright).

## Files

- `aesop-fables.epub` — _Aesop's Fables (Selections)_ ("The North Wind and the Sun", "The Ant
  and the Grasshopper"). Aesop's fables are ancient and in the public domain worldwide. This
  EPUB is generated deterministically by `scripts/make-fixture-epub.mjs`; regenerate with
  `node scripts/make-fixture-epub.mjs`. Used as the **English (Latin-script)** fixture.

- `today-cycle.epub` — _Aesop's Fables (Today Cycle)_ ("The Fox and the Grapes", "The Lion and
  the Mouse"). Aesop's fables are ancient and in the public domain worldwide. This EPUB is
  generated deterministically by `scripts/make-today-fixture-epub.mjs`; regenerate with
  `node scripts/make-today-fixture-epub.mjs`. It has distinct bytes from `aesop-fables.epub` so
  the Today daily-cycle E2E (`e2e/tests/today-daily-cycle.spec.ts`) can adopt its own recitation
  Work without colliding with the shared `setup.epub`.

- `recitation-aggregate-a.epub` / `recitation-aggregate-b.epub` — _Aesop's Fables (Aggregate A / B)_,
  two disjoint fable pairs. Aesop's fables are ancient and in the public domain worldwide. Both are
  generated deterministically by `scripts/make-aggregate-fixture-epubs.mjs`; regenerate with
  `node scripts/make-aggregate-fixture-epubs.mjs`. Each has distinct bytes from every other fixture
  and from each other so the recitation aggregate E2E
  (`e2e/tests/recitation-aggregate.spec.ts`) can adopt **two separate** recitation Works without the
  uploads deduping to the same Work.

- `three-character-classic.epub` — _三字经_ (the Three Character Classic), a classical Chinese
  primer (~13th century). The text is in the public domain; this EPUB was produced by the
  公版书 (public-domain books) project at https://www.7sbook.com, whose notice explicitly
  permits free copying, distribution, and adaptation, including commercial use. Used as the
  **CJK** fixture so the screenshots exercise the reader's CJK-aware typography.

If you add more fixtures, keep them small and public-domain, and record their provenance here.
