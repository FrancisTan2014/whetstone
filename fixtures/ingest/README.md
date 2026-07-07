# Ingestion fidelity corpus (#520)

Synthetic, **public-domain** construct fixtures for the committed EPUB ingestion-fidelity invariant
harness (`src/apps/server/src/features/content/ingestionFidelity.test.ts`). They reproduce real
publisher construct shapes so ingestion never silently regresses the classes we have fixed repeatedly
(figures dropped, paragraphs shattered, nav anchors unresolved, unknown blocks).

Everything here is **hand-authored / public-domain** (Aesop's fables text + synthetic technical prose) —
never a copyrighted book, and no machine-specific path is committed.

## Files

- `chapter1.xhtml` — a `<div class="sect1" id="…">` section wrapper with prose paragraphs, plus a
  standalone `<img>` and a `<figure>` (figure capture).
- `chapter2.xhtml` — a code block with numbered callout markers, a `<dl><dt><dd>`, an inline `<tt>`,
  CJK inter-element spacing, and a footnote (`data-type="noteref"`) marker + its `<aside>`.

The harness pairs these with a **Part-as-sibling** authored nav (built in the test) and asserts the
fidelity contract (no unknown blocks / no shattered paragraphs / figures captured / every nav anchor
resolves / no whole-block note-anchor `out_of_range`).

## Known gap the harness surfaces

A `<figure>`/`<img>` nested **inside** a structural `<div>`/`<section>` wrapper is currently dropped by
the top-level decomposition walk (it passes wrapper divs through the mdast pipeline, which loses
standalone images) — so those figures produce **no** figure block and **no** fail-loud evidence. The
figures in this corpus are therefore authored at the chapter top level. Capturing wrapper-nested figures
(and adding the `<svg><image>` / inline-MathML / endnote constructs, plus the opt-in local corpus runner
of #520 Part 2) are focused follow-ups.
