# EPUB fixtures

Small, **public-domain** EPUBs used only by the manual screenshot harness
(`scripts/screenshots.mjs`, run via `pnpm screenshots`). They are ingested through the live
ingestion pipeline so the captured screenshots show how the app renders real content. They
are **not** part of the test suite or the `pnpm validate` gate.

## Files

- `aesop-fables.epub` — *Aesop's Fables (Selections)* ("The North Wind and the Sun", "The Ant
  and the Grasshopper"). Aesop's fables are ancient and in the public domain worldwide. This
  EPUB is generated deterministically by `scripts/make-fixture-epub.mjs`; regenerate with
  `node scripts/make-fixture-epub.mjs`. Used as the **English (Latin-script)** fixture.

- `three-character-classic.epub` — *三字经* (the Three Character Classic), a classical Chinese
  primer (~13th century). The text is in the public domain; this EPUB was produced by the
  公版书 (public-domain books) project at https://www.7sbook.com, whose notice explicitly
  permits free copying, distribution, and adaptation, including commercial use. Used as the
  **CJK** fixture so the screenshots exercise the reader's CJK-aware typography.

If you add more fixtures, keep them small and public-domain, and record their provenance here.
