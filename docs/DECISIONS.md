# Decisions & history — superseded choices

whetstone's **archive of superseded decisions**: choices that were once current and are now replaced.
The live docs (`PRODUCT.md`, `GUIDELINES.md`, the agent/skill files, `docs/MAP.md`) carry only the
**current** truth; the rationale and the trail of what we moved away from live here so the reasoning is
never lost and never clutters the working docs.

Each entry is a short decision record: what it was, when and why it was superseded, and what replaced
it. Newest first.

---

## D8 — Page coverage as completeness evidence → the converter's own status, fail-closed

**Status:** Superseded 2026-08-04, before shipping, by direct measurement on a real book.
**Replaced by:** the "a conversion is complete or it is refused" rule in `PRODUCT.md` →
"v0 content ingestion", now resting on the converter's reported status alone.

**What it was.** D7 established that a converter result is untrusted evidence and must be refused
unless it reports unqualified success. Alongside that status gate, #834/#835 added a second,
independent invariant intended as defence in depth for the case where a converter reports success but
silently under-produces: every page the source's text layer reports as carrying native text had to be
accounted for by at least one item the converter emitted for that page. #837/#838 refined it once
already, after review found the first form counted only **body** items and would therefore refuse a
healthy book on its running heads, folios, and numbered blank pages; the refinement widened the
accounting to include page furniture, so a page satisfied the invariant if everything recognised on it
was furniture. Both forms shared one premise: that a page which produced no item had not been
processed.

**Why superseded.** That premise is false, and measurement falsified it before the invariant shipped.
Running the production worker over pages 21–30 of the same 462-page Clean Code PDF that motivated
#832, the converter reported `SUCCESS` and page 25 produced **zero items of any kind** — neither body
nor furniture. Page 25 and page 29 of that book carry byte-identical native text, the 35-character
string `'This page intentionally left blank '`, on identically sized 518x666 pages, with an identical
text bounding box of (181,494)-(342,505). In the *same* run, page 29 produced one text item and page
25 produced none. Re-running the identical range reproduced the split exactly, so this is deterministic
context sensitivity in the converter's layout model, not flakiness. Item production is therefore a
function of the batch a page is converted in, not of whether the page was converted at all.

The exposure was structural rather than incidental: 15 of the book's 462 pages carry that notice
(7, 19, 25, 29, 31, 47, 133, 165, 183, 223, 297, 347, 379, 439, 443). Running the real mapper over the
real payload confirmed the outcome — `incomplete_conversion`, one page reported lost — so the
invariant would have refused a book we had just proven converts completely, 461 of 462 pages and
3,038 blocks. Refusing a good book loudly is a worse failure than the silent partial import #832 set
out to fix, and no adjustment to *which* item groups count can repair a proxy that is zero for a page
that converted perfectly. A proportional tolerance was rejected with it: "complete or refused, unless
fewer than N% of pages are missing" is a different and weaker rule, and the threshold would have been
unprincipled.

**What replaced it.** Nothing was added in its place, and the completeness rule itself did not change
— what narrowed is the **evidence** admitted to decide it, not the standard. Completeness is now
judged solely from the converter's own record of what it did: the status gate, hardened to fail
closed, so a result that does not report unqualified success is refused and a result that cannot
report a status at all is refused with it. Closing that seam matters more now that the gate stands
alone: the converter version is pinned, so an absent status is not an expected shape, and a future
upgrade that changes the reporting contract fails loudly at the boundary instead of silently
reopening #832. The gate refuses on status alone; the converter's `errors` are read only to describe
the failure to an operator.

Real per-page processing evidence — `ConversionResult.pages`, which records what the converter
actually did to each page independently of what that page yielded — is the correct backstop and is
filed as follow-up work with this measurement attached. It was not adopted here: its marginal value
over the status gate is currently hypothetical, it changes the payload contract, and a new evidence
channel should not be designed and validated alongside the half that actually fixes the defect.

---

## D7 — Memory ceiling assumed to fail loudly → converter results are untrusted evidence


**Status:** Superseded 2026-08-04 by a reproduced silent-truncation failure.
**Replaced by:** the "a conversion is complete or it is refused" rule in `PRODUCT.md` →
"v0 content ingestion".

**What it was.** An over-budget conversion was assumed to terminate visibly, so the worker's hard
memory ceiling was read as a bound that could only be respected or hit loudly. (The neighbouring rule
that a host unable to enforce the ceiling refuses the import was never in doubt and still stands; only
the assumption about what happens *under* the ceiling was wrong.) On that assumption the worker
consumed only `result.document` from the pinned converter and never
inspected the run's reported status, and publication's only content refusals were "a page has no
native text" (OCR required) and "zero canonical blocks" (no empty shell).

**Why superseded.** A bounded conversion does not fail loudly — it degrades quietly. Docling catches a
per-page allocation failure, drops that page, continues, and returns a document containing only the
pages that survived, reporting the run as `PARTIAL_SUCCESS`. Because the worker read only the
document, the fragment was committed as a good range and published as a whole book. A real 462-page
import published **335 blocks / 87,359 characters (~9% of the book) across 54 of its 462 pages**,
while the attempt recorded `state='converted'`, `failure=null`, and `completed_pages=462/462`. Both
existing refusals passed: the dropped pages *did* have native text, and the block count was not zero.

Reproduced deterministically with the production worker code and the production ceiling: status
`PARTIAL_SUCCESS`, 45 of 50 pages failed with `std::bad_alloc` in the converter's preprocess model,
yielding 5 usable pages. The same range converted with the ceiling lifted returns all 50 pages and
95,158 characters, so extraction was never the problem.

Measurement also showed the ceiling itself was specified against the wrong quantity. The Windows Job
Object bounds **committed** memory, and the pinned converter's torch/MKL runtime commits far more than
it ever touches: the same range peaks at **31.78 GiB committed against a 2.48 GiB working set**, a
ratio of roughly 13x. (Pinning `OMP`/`MKL`/`OPENBLAS` to 4 threads was measured and moves it only to
30.70 GiB, so thread count is not the cause; the mechanism behind the reservation was not established
and nothing here depends on it.) A 6 GiB commit ceiling therefore throttles a conversion whose real footprint is under
2.5 GiB, and no commit ceiling can both admit the converter and bound real memory pressure.

**What replaced it.** A converter result is untrusted evidence, not a source of truth. Any result not
reporting unqualified success is refused, and an independent coverage invariant refuses a fragment
even from a converter that claims success: every page the source reports as carrying native text must
be accounted for, either by a body item or by having yielded only page furniture, and a page that
yields neither is counted as lost. (**Superseded in part by D8:** the coverage invariant was falsified
by measurement before it shipped and removed; the untrusted-evidence rule stands, now carried by the
status gate alone, made fail-closed.) Ceilings are calibrated against what the pinned converter
actually commits on the host, and a ceiling that throttles a supported book is a defect of the
ceiling rather than an acceptable degradation.

**Rejected alternatives (still rejected).** Publishing the fragment with a warning, auto-retrying a
degraded range, or lowering the refusal to an advisory: a partial book passes every existing gate,
looks like a real import, and is discovered only while reading — worse for the learner than a visible
failure. Replacing the converter remains rejected by D6: extraction is reliable when it is allowed to
finish.

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
