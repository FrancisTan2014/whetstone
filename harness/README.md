# The retained-payload harnesses

These three files turn a 30-minute PDF re-conversion into a 0.3-second test. They are how every
measurement in `HANDOFF-pdf-reading-quality.md` was produced, and they are the fastest way to check
whether a change to PDF mapping actually improves the reading experience on a real 462-page book.

They are **deliberately not part of any product PR**. They read a local fixture that is provenance
data, not source, and they print rather than assert. Keep them here.

## Why they work

`removeRetainedStage` (`pdfImportPublish.ts`) frees only the **stage directory** on publish. The
`pdf_import_ranges.payload` jsonb column **survives publication**. Every *published* attempt therefore
still holds its complete converted document; only *failed* attempts have none.

For Clean Code that is 10 ranges, 819 KB, including the full 384-entry bookmark outline — everything
`mapStructuredDocument` needs, without touching the PDF or the Python worker.

## Producing the fixture

Copy the PGlite directory first so nothing is locked or mutated:

```powershell
Copy-Item "Q:\src\whetstone\src\apps\server\.data\db\*" "Q:\src\whetstone\artifacts\dbsnap" -Recurse
```

Then dump the ranges for the attempt you care about:

```js
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(SNAPSHOT_DIR);
await db.waitReady;
// NOTE: there is NO 'published' state. Verified on the live database, the only
// states are 'converted' (5 rows) and 'failed' (4). Publication is recorded in a
// SEPARATE table, so join through it rather than filtering on state:
const attempt = (await db.query(
  `select a.id, a.source_hash, a.total_pages
     from pdf_import_publications p
     join pdf_import_attempts a on a.id = p.attempt_id
     join work_meta w on w.entry_id = p.work_entry_id
    where w.title like $1
    order by p.created_at asc
    limit 1`,
  ['%Clean Code%']
)).rows;
const ranges = (await db.query(
  `select range_index, payload from pdf_import_ranges where attempt_id = $1 order by range_index`,
  [attemptId]
)).rows;
// write { attempt, ranges } as JSON
```

The harnesses default to `Q:\src\whetstone\artifacts\remap\cleancode-ranges.json`; override with
`REMAP_FIXTURE`.

## Running them

Drop a harness into `src/apps/server/` of the worktree you want to measure, then **run vitest from the
repository root** — its `include` globs are repo-root-relative, so running from `src/apps/server`
silently finds no tests:

```powershell
npx vitest run src/apps/server/remap.harness.test.ts --testTimeout=180000
```

Delete it afterwards so it never lands in a PR.

## The six harnesses

| file | what it answers |
|---|---|
| `remap.harness.test.ts` | The whole-book census: unit count, block count, text characters, block-type histogram, heading-level sources, unmapped labels, unit titles and sizes. Also carries a heading-length census (that is how #856 was measured). |
| `readquality.harness.test.ts` | *What does a chapter actually read like?* Dumps one unit block by block with type, heading level, and text. Set `RQ_UNIT` and `RQ_LIMIT`. This is the harness that showed Chapter 1 reads correctly and that `Contents` is 610 empty blocks. |
| `opener.harness.test.ts` | Censuses the first two blocks of every unit. This is how the split chapter opener (#867) was found and quantified — 13 of 28 units. |
| `usability.harness.test.ts` | **The acceptance measurement.** Per unit: how many blocks contain no text at all. This is the number that answers "is the book usable?". On `main` at `cbb552c9` it reports 28 units / 3,054 blocks / 857,985 chars / 44 empty (1%). If a change moves that triple, something regressed. |
| `prose.harness.test.ts` | Prints one unit as continuous prose. Set `WT_UNIT` and `WT_CHARS`. **Use it before believing any measurement** — this is what showed the prose is genuinely good. |
| `code.harness.test.ts` | Counts how many `codeBlock` blocks contain a newline, and prints one listing verbatim. **This found #876** — 0 of 520 — after every character count had said the book was fine. |
| `typography.harness.test.ts` | Counts reader-visible spacing defects in prose only (space before punctuation, broken contractions). Backs #874. Deliberately reports double spaces as *not visible*, because reader paragraphs collapse them. |

## Reading beats counting

`usability`, `remap`, and `opener` all count. They were unanimous that the book was fine, and they
were all blind to the fact that **every code listing had been flattened to a single line** — because
the characters were all present, just on one line. `prose` and `code` exist because of that. Run them.

## Traps that cost time

- **The row's `payload` IS a `RangeConversion`.** Do not wrap it in `{ document: … }`.
- **`concatenateRanges` is exported from `@whetstone/contracts`**, not from the pdfImport feature.
- Units are `PersistableReadingUnit`; blocks are **`u.docBlocks`**, not `u.blocks`.
- **`plaintext` is not populated** on the harness's in-memory result — walk `node.content` recursively
  collecting `.text`. (Production computes it with `documentText`, which is also what `blockWriter`
  persists, so if you want to measure exactly what reaches PostgreSQL, use `documentText`.)
- In a fresh worktree, junction `node_modules` at the repo root **and** in every `src/packages/*` and
  `src/apps/*` — a root-only link gives a misleading `Cannot find package 'zod'`.

## The measurement discipline these exist to enforce

Twice during this run I reasoned from code I had read to a conclusion about data I had never measured,
and both times the measurement falsified me. Block counts and `unknown` counts are especially
treacherous: the wrong fix for #859 ("skip expanding table-shaped containers") produces 3,024 blocks
and 0 `unknown` — metrics that look like success — while silently dropping 70,103 characters.

**Measure text, not shape.** If a change claims to improve reading, make it show the text.

## The `concatenateRanges` signature (cost me two runs)

It takes **two** arguments, source first:

```ts
concatenateRanges(
  { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
  dump.ranges.map((r) => r.payload)
);
```

Calling it with just the array fails deep inside with `Cannot read properties of undefined (reading '0')`.
The mapper entry point is **`mapStructuredDocument`**, not `mapDoclingDocumentToWork`.

## The payload shape, so you do not have to rediscover it

```
range   : rangeIndex, startPage, endPage, fingerprint, payload
payload : body[], pages[], outline[], metadata, furniture[], doclingSchema, schemaVersion
body[i] : text, label, charSpan, children, confidence, pageNumber, boundingBox
pages[i]: pageNumber, hasNativeText          <- no cells, no per-line geometry
outline : level, title, pageNumber
```

Body labels present in Clean Code, by count:

```
text=1750  table_cell=984  page_header=839  table_row=761  section_header=525  code=521
row_header=331  list_item=162  footnote=101  picture=55  list=51  page_footer=46
document_index=30  caption=17  column_header=15  key_value_area=8  table=8  form_area=1
```

Note `pages[]` carries **no text cells**. That is why code line structure cannot be recovered from a
retained payload (#876) — it has to be captured in the worker, before the payload is written.