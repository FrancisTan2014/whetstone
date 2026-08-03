# Decisions & history — superseded choices

whetstone's **archive of superseded decisions**: choices that were once current and are now replaced.
The live docs (`PRODUCT.md`, `GUIDELINES.md`, the agent/skill files, `docs/MAP.md`) carry only the
**current** truth; the rationale and the trail of what we moved away from live here so the reasoning is
never lost and never clutters the working docs.

Each entry is a short decision record: what it was, when and why it was superseded, and what replaced
it. Newest first.

---

## D6 — "PDF extraction loses the text" → measured extraction reliability; the defect is our mapping

**Status:** Superseded 2026-08-03 by direct measurement.
**Replaced by:** the canonical-mapping rules and measured usability definition in `PRODUCT.md` →
"v0 content ingestion".

**What it was.** The working diagnosis for the Reader's poor PDF results was that the converter itself
lost roughly 90% of a book's text, which made "replace or bypass the extractor" look like the fix and
kept alternatives such as a PDF-specific reader or a Markdown/EPUB intermediate alive in discussion.

**Why superseded.** That number was a measurement artifact: the walker used to measure it did not
traverse docling table cells, so table-borne text (all of a book's front-matter contents pages) read as
missing. Re-measured with the pinned converter (docling 2.114.0, `do_ocr=False`) against each PDF's own
text layer read through pypdfium2, normalized whitespace-stripped:

| Source | Pages | Recursive item text | Top-level body only | `export_to_html` |
| --- | --- | --- | --- | --- |
| Clean Code | 1–30 | 41.1% | 38.8% | 103.8% |
| Clean Code | 50–60 | 99.8% | 99.8% | 108.5% |
| Clean Code | 120–140 | 99.9% | 99.5% | 105.6% |
| Seven Concurrency Models | 40–55 | 99.5% | 93.9% | 101.3% |

An independent re-run over Clean Code pages 124–129 measured 99.7–99.9% per page (99.8% overall) with
table/list descendants included. The 41.1% row is front matter whose contents pages are 11 docling
tables; `export_to_html` reaching 103.8% there proves the text is present, and the worker already
projects table cells via `_table_rows`.

**What replaced it.** Extraction is treated as reliable, and every observed Reader defect is owned by
the canonical mapping layer (`pdfCanonicalMapping.ts`): page furniture flooding the body as unknown
blocks (~26% of top-level items measured), heading level assigned from a label so every book is flat,
a new ReadingUnit at every heading, and descendants of unmapped parents dropped. Usability is
certified by measured page coverage, furniture contamination, and outline quality rather than
fallback-block ratios. The recorded future direction is convergence onto EPUB's proven
`htmlToDocument` mapper through a structured-semantic-HTML intermediate carrying page/bbox/confidence
sidecars.

**Rejected alternatives (still rejected).** A PDF.js or otherwise PDF-specific reader, a page-block
content model, and retaining the PDF as the readable copy — all remain superseded by D4. Converting
PDF to EPUB or Markdown as an intermediate file hop: Markdown is strictly narrower than the canonical
schema and destroys page, bounding-box, and confidence provenance. Everything is still a block, and
every source format still becomes one canonical ProseMirror `Work -> ReadingUnit -> Block`.

---

## D5 — Seven-day queue lock → non-blocking daily-use evidence

**Status:** Superseded 2026-07-22.
**Replaced by:** continuous bug-first delivery until the daily routine is usable, followed by sustained
use as product-completion evidence (`PRODUCT.md` → "Product-completion threshold").

**What it was.** Every broader feature issue depended on a human-run gate requiring one complete
walkthrough and seven unchanged days of normal use.

**Why superseded.** The gate made usability a prerequisite for the work needed to achieve usability.
When the maintainer could not complete daily routines, every remediation and missing capability was
still frozen behind the failed routine, leaving no path back to a testable build.

**What replaced it.** Loop-breaking defects enter the deterministic bug-first queue and scoped
delivery continues. Once a stable build supports the real routine, the walkthrough and seven-day
window remain meaningful completion evidence; a runtime change restarts that evidence window but
never freezes delivery.

---

## D4 — Fixed-layout PDF reader → canonical block ingestion

**Status:** Superseded 2026-07-22.
**Replaced by:** one-reader, one-document-model ingestion (`PRODUCT.md` → "v0 content ingestion" and
"Architecture: the document-model bedrock").

**What it was.** PDF was treated as a permanent fixed-layout exception: retained pages were visual
truth, PDF.js rendered them in a format-specific Reader branch, page blocks carried a parallel text
projection, range serving fed the browser, and OCR enriched those retained pages later.

**Why superseded.** The design optimized PDF page rendering instead of Whetstone's ingestion product.
It split one Reader and one canonical ProseMirror hierarchy into a second content architecture, made
source pixels authoritative over correctable blocks, and measured PDF.js parse/render success rather
than semantic ingestion usability. It also could not reuse the shared rich editor to repair the
inevitable minority of imperfect extractions.

**What replaced it.** Every format-specific adapter ends at canonical ProseMirror
`Work -> ReadingUnit -> Block` content. PDF conversion uses bounded, versioned structured-document
output mapped directly to those blocks; page geometry and confidence remain evidence, the immutable
source remains provenance/export, and administrators correct imperfect canonical blocks in the shared
editor. The target is at least 95% usable automatic ingestion on the supported pressure corpus, with
explicit correction for the remainder. **Do not reintroduce a PDF-specific reader or page-block
content model.**

---

## D3 — Loop dispatch: external/background coordinator → in-session self-paced foreground loop

**Status:** Superseded (the first harness's coordinator role + background dispatch).
**Replaced by:** each role runs its own in-session, self-paced **foreground** loop (the `## Run
automatically` sections of the agent docs; `scripts/run-*-auto.cmd`).

**What it was.** A **coordinator role** dispatched the developer/reviewer/tester by starting them as
**background tasks**.

**Why superseded.** **Background tasks fail silently** — a dispatched role could die or stall with no
signal, wedging the loop with no error surfaced. An external coordinator is a fragile single point of
failure.

**What replaced it.** No coordinator. Each role drives itself with Copilot's scheduled-task feature as a
**foreground, single-threaded, self-re-arming** loop: visible, never silently dropped, and stateless
between ticks (it re-derives everything from GitHub — see D2). The accepted trade-off is some context
accumulation within a long-lived session, bounded by the read-minimum discipline + runtime compaction —
robustness and visibility beat leanness. **Do not reintroduce an external or background coordinator.**

---

## D2 — Workflow status: local state machine → GitHub issues as the source of truth

**Status:** Superseded (the first harness's local state machine).
**Replaced by:** GitHub issues / labels / PRs as the single source of truth
(`.github/copilot-instructions.md`; the agent loop in `scripts/`).

**What it was.** The first workflow tracked run/queue status in a **local state machine** (shared local
status/state on disk).

**Why superseded.** A local state machine is **fragile**: it desyncs from reality, can't be trusted
across crashes/restarts, and — critically — **cannot coordinate parallel workers**.

**What replaced it.** **GitHub issues are the authoritative status** — labels are the queue state, the
issue is the spec, the PR + review comment are the handoff. Agents are stateless between ticks and
re-derive everything from GitHub. This made the loop **robust and trustworthy** (it clears the queue
unattended) and is exactly what makes **horizontal scaling safe**: multiple developer/reviewer workers
coordinate through one authoritative store, with no fragile shared local state. (Speed is then a pure
function of tick cadence + worker count, not correctness.)

---

## D1 — Content representation: mdast block storage + HTML→mdast pipeline + react-markdown rendering

**Status:** Superseded 2026-06-30.
**Replaced by:** the document-model bedrock — `PRODUCT.md` → "Architecture: the document-model
bedrock"; build issues #310–#313.

**What it was.** Content was stored as `Block` rows holding an **mdast** node (a Markdown AST) +
plaintext. Ingestion normalized every format to mdast (`upload → adapter → mdast → blocks`; EPUB XHTML
→ mdast via `rehype-parse` + `rehype-remark`; Markdown via `remark-parse` + `remark-gfm`). The reader
rendered each block's mdast (`mdast-util-to-hast` → `hast-util-sanitize` → React via
`hast-util-to-jsx-runtime`); highlights were applied by a hast tree-walk; Markdown export reassembled
blocks via `remark-stringify`.

**Why superseded.** mdast is a *Markdown* AST, so it can only represent what Markdown can express — it
**silently dropped** real publisher constructs (figure, definition list, O'Reilly callouts, footnote
references), which surfaced as a recurring class of "ingestion bugs" (closed #301, #305, #307). It also
could not natively support in-place **editing** or robust **annotation** — both became first-class once
whetstone was understood as a read-*and*-write personal learning app.

**What replaced it.** A schema-based block document — the **ProseMirror** model consumed via **Tiptap**
(MIT). Source HTML → document via `parseDOM` node specs with a fail-loud `unknown`-node + structured
evidence log (nothing silently dropped); `@tiptap/static-renderer` for rendering; annotations as
**Decorations** over an external anchor store (never marks); block rows now carry the **ProseMirror
node** + a stable id (Tiptap UniqueID). Markdown/mdast is retained as **import/export only**. There was
**no migration** — no real data yet (in-memory dev runs) — so this is a clean rebuild, not a data
conversion.

**Rejected alternatives.** BlockNote (MPL-2.0 core + GPL-3.0 packages — license constraint); Lexical
(not a block-document model; pre-1.0); raw ProseMirror (its own repos are archived — consume via the
actively-maintained Tiptap).
