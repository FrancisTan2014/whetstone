# Ingestion fidelity corpus (#520)

Synthetic, **public-domain** construct fixtures for the committed EPUB ingestion-fidelity invariant
harness (`src/apps/server/src/features/content/ingestionFidelity.test.ts`). They reproduce real
publisher construct shapes so ingestion never silently regresses the classes we have fixed repeatedly
(figures dropped, paragraphs shattered, nav anchors unresolved, unknown blocks).

Everything here is **hand-authored / public-domain** (Aesop's fables text + synthetic technical prose) —
never a copyrighted book, and no machine-specific path is committed.

## Files

- `chapter1.xhtml` — a `<div class="sect1" id="…">` section wrapper with prose paragraphs, a
  standalone `<img>`, a `<figure>` nested inside inner `<div>`/`<section>` wrappers, and an
  `<svg><image href>` raster wrapper (figure capture across all three shapes).
- `chapter2.xhtml` — a code block with numbered callout markers, a `<dl><dt><dd>`, an inline `<tt>`,
  CJK inter-element spacing, inline MathML (`<math>`), and both a footnote and an endnote
  (`data-type="noteref"` markers) with their `<aside>` targets.

The harness pairs these with a **Part-as-sibling** authored nav (built in the test) and asserts the
fidelity contract (no unknown blocks / no shattered paragraphs / figures captured / every nav anchor
resolves / no whole-block note-anchor `out_of_range`).

## Wrapper-nested figures and SVG wrappers

Earlier, a `<figure>`/`<img>` nested **inside** a structural `<div>`/`<section>` wrapper was dropped by
the top-level decomposition walk (it handed wrapper subtrees to the mdast pipeline, which has no
standalone-image/figure block) — producing no figure block and no fail-loud evidence. That gap is now
fixed: `decomposeHtmlChapter` flattens `div`/`section`/`article` wrappers (transferring a wrapper's
section id to its leading child), and the server ingestion unwraps `<svg><image>` raster wrappers into
`<img>` before the fail-loud walk. This corpus authors the figures nested in wrappers precisely to hold
that fix in place. The opt-in local corpus runner of #520 Part 2 remains a focused follow-up.
