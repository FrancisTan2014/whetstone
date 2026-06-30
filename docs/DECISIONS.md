# Decisions & history — superseded choices

whetstone's **archive of superseded decisions**: choices that were once current and are now replaced.
The live docs (`PRODUCT.md`, `GUIDELINES.md`, the agent/skill files, `docs/MAP.md`) carry only the
**current** truth; the rationale and the trail of what we moved away from live here so the reasoning is
never lost and never clutters the working docs.

Each entry is a short decision record: what it was, when and why it was superseded, and what replaced
it. Newest first.

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
