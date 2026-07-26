import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toEntryId, type EntryId } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, docBlocks, entries, pdfBlockEvidence, workMeta } from "../../db/schema.js";
import {
  initializeEditableWorkContent,
  reconcileEditableWorkContent
} from "../content/editableWorkContent.js";
import { loadPdfExtractionEvidence } from "./pdfExtractionEvidenceQueries.js";

// #763 read side: the extraction-evidence query projects the SAFE per-block provenance for a correctable
// imported Work, derives the shared review suggestion from confidence + the persisted node type, and
// reports whether each block has been corrected. These seed the real evidence/doc_blocks shapes against a
// real database and prove threshold boundaries, null confidence, known/unknown labels, cross-Work
// isolation, OCR/native evidence, corrected suppression, and the eligibility gate.

let db: DbClient;
let pglite: PGlite;
let sequence = 0;
const createEntryId = (): string => `unit-${(sequence += 1)}`;

function para(text: string, id: string): DocumentNodeJSON {
  return { attrs: { id }, content: [{ text, type: "text" }], type: "paragraph" };
}

function doc(...nodes: ReadonlyArray<DocumentNodeJSON>): DocumentNodeJSON {
  return { content: [...nodes], type: "doc" };
}

// A canonical imported Work (PDF-style: `origin = imported`, one unit rendered from `doc_blocks`),
// returning its work id and first unit id so a test can attach evidence-bearing blocks to that unit.
async function seedCanonicalImported(
  entryId: string
): Promise<{ unitEntryId: string; workEntryId: EntryId }> {
  await db.insert(authors).values({ id: `author-${entryId}`, name: entryId, nameKey: entryId });
  await db.insert(entries).values({ id: entryId, type: "work" });
  await db.insert(workMeta).values({
    authorId: `author-${entryId}`,
    entryId,
    language: "en",
    origin: "imported",
    title: `Work ${entryId}`,
    workType: "book"
  });
  const { unitEntryId } = await db.transaction((tx) =>
    initializeEditableWorkContent(tx, { createEntryId, workEntryId: toEntryId(entryId) })
  );
  await db.transaction((tx) =>
    reconcileEditableWorkContent(tx, {
      document: doc(para("Imported body", `${entryId}-b1`)),
      unitEntryId,
      workEntryId: toEntryId(entryId)
    })
  );
  return { unitEntryId, workEntryId: toEntryId(entryId) };
}

// Insert one canonical block plus its additive PDF evidence row. `type` is the persisted canonical node
// type (`unknown` == the mapper's fallback path); `correctedAt` marks a hand-corrected block.
async function seedBlockWithEvidence(
  workEntryId: string,
  unitEntryId: string,
  block: Readonly<{
    confidence: number | null;
    correctedAt?: Date;
    id: string;
    label: string;
    ocrEngine?: string;
    ocrLanguage?: string;
    page: number;
    type: string;
  }>
): Promise<void> {
  await db.insert(entries).values({ id: block.id, type: "block" });
  await db.insert(docBlocks).values({
    correctedAt: block.correctedAt ?? null,
    id: block.id,
    nodeJson: { type: block.type },
    orderIndex: (sequence += 1),
    plaintext: block.id,
    readingUnitEntryId: unitEntryId,
    type: block.type,
    workEntryId
  });
  await db.insert(pdfBlockEvidence).values({
    blockId: block.id,
    confidence: block.confidence,
    label: block.label,
    ocrEngine: block.ocrEngine ?? null,
    ocrLanguage: block.ocrLanguage ?? null,
    page: block.page,
    workEntryId
  });
}

beforeEach(async () => {
  sequence = 0;
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

describe("loadPdfExtractionEvidence — eligibility gate", () => {
  it("returns undefined for an unknown work id", async () => {
    expect(await loadPdfExtractionEvidence(db, toEntryId("missing"))).toBeUndefined();
  });

  it("returns undefined for a manual (non-imported) work", async () => {
    await db.insert(authors).values({ id: "author-m", name: "m", nameKey: "m" });
    await db.insert(entries).values({ id: "manual-1", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-m",
      entryId: "manual-1",
      language: "en",
      origin: "manual",
      title: "Manual",
      workType: "book"
    });
    const { unitEntryId } = await db.transaction((tx) =>
      initializeEditableWorkContent(tx, { createEntryId, workEntryId: toEntryId("manual-1") })
    );
    await db.transaction((tx) =>
      reconcileEditableWorkContent(tx, {
        document: doc(para("Body", "manual-1-b1")),
        unitEntryId,
        workEntryId: toEntryId("manual-1")
      })
    );

    expect(await loadPdfExtractionEvidence(db, toEntryId("manual-1"))).toBeUndefined();
  });

  it("returns an empty list for a correctable imported Work with no PDF evidence", async () => {
    const { workEntryId } = await seedCanonicalImported("epub-1");

    expect(await loadPdfExtractionEvidence(db, workEntryId)).toEqual({ items: [] });
  });
});

describe("loadPdfExtractionEvidence — projection and policy", () => {
  it("suppresses a review suggestion for a high-confidence mapped block", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("pdf-1");
    await seedBlockWithEvidence("pdf-1", unitEntryId, {
      confidence: 0.9,
      id: "pdf-1-high",
      label: "text",
      page: 1,
      type: "paragraph"
    });

    const result = await loadPdfExtractionEvidence(db, workEntryId);

    expect(result?.items).toEqual([
      {
        blockId: "pdf-1-high",
        confidence: 0.9,
        corrected: false,
        label: "text",
        ocrEngine: null,
        ocrLanguage: null,
        page: 1,
        reviewSuggested: false
      }
    ]);
  });

  it("suggests review for a below-threshold confidence and passes OCR provenance through", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("pdf-2");
    await seedBlockWithEvidence("pdf-2", unitEntryId, {
      confidence: 0.4,
      id: "pdf-2-low",
      label: "text",
      ocrEngine: "tesseract-5.3",
      ocrLanguage: "eng",
      page: 2,
      type: "paragraph"
    });

    const result = await loadPdfExtractionEvidence(db, workEntryId);

    expect(result?.items[0]).toMatchObject({
      confidence: 0.4,
      ocrEngine: "tesseract-5.3",
      ocrLanguage: "eng",
      reviewSuggested: true
    });
  });

  it("suggests review for an unmapped block even at high confidence", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("pdf-3");
    await seedBlockWithEvidence("pdf-3", unitEntryId, {
      confidence: 0.99,
      id: "pdf-3-unknown",
      label: "chart",
      page: 1,
      type: "unknown"
    });

    const result = await loadPdfExtractionEvidence(db, workEntryId);

    expect(result?.items[0]?.reviewSuggested).toBe(true);
  });

  it("does not suggest review for a null-confidence mapped block (missing is not below threshold)", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("pdf-4");
    await seedBlockWithEvidence("pdf-4", unitEntryId, {
      confidence: null,
      id: "pdf-4-null",
      label: "text",
      page: 1,
      type: "paragraph"
    });

    const result = await loadPdfExtractionEvidence(db, workEntryId);

    expect(result?.items[0]).toMatchObject({ confidence: null, reviewSuggested: false });
  });

  it("reports a corrected block as corrected while still returning its original evidence", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("pdf-5");
    await seedBlockWithEvidence("pdf-5", unitEntryId, {
      confidence: 0.3,
      correctedAt: new Date("2026-07-01T00:00:00.000Z"),
      id: "pdf-5-corrected",
      label: "text",
      page: 4,
      type: "paragraph"
    });

    const result = await loadPdfExtractionEvidence(db, workEntryId);

    expect(result?.items[0]).toMatchObject({
      confidence: 0.3,
      corrected: true,
      label: "text",
      page: 4,
      reviewSuggested: true
    });
  });

  it("returns evidence only for the requested Work (cross-Work isolation)", async () => {
    const first = await seedCanonicalImported("pdf-6");
    const second = await seedCanonicalImported("pdf-7");
    await seedBlockWithEvidence("pdf-6", first.unitEntryId, {
      confidence: 0.5,
      id: "pdf-6-b",
      label: "text",
      page: 1,
      type: "paragraph"
    });
    await seedBlockWithEvidence("pdf-7", second.unitEntryId, {
      confidence: 0.5,
      id: "pdf-7-b",
      label: "text",
      page: 1,
      type: "paragraph"
    });

    const result = await loadPdfExtractionEvidence(db, first.workEntryId);

    expect(result?.items.map((item) => item.blockId)).toEqual(["pdf-6-b"]);
  });

  it("orders evidence by source page", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("pdf-8");
    await seedBlockWithEvidence("pdf-8", unitEntryId, {
      confidence: 0.9,
      id: "pdf-8-p3",
      label: "text",
      page: 3,
      type: "paragraph"
    });
    await seedBlockWithEvidence("pdf-8", unitEntryId, {
      confidence: 0.9,
      id: "pdf-8-p1",
      label: "text",
      page: 1,
      type: "paragraph"
    });

    const result = await loadPdfExtractionEvidence(db, workEntryId);

    expect(result?.items.map((item) => item.page)).toEqual([1, 3]);
  });
});
