import { PGlite } from "@electric-sql/pglite";
import type * as NodeChildProcess from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  type RangeConversion,
  type StructuredDocItem
} from "@whetstone/contracts";
import { documentText, type DocumentNodeJSON } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  entryLinks,
  pdfBlockEvidence,
  pdfImportAttempts,
  pdfImportPublications,
  pdfImportRanges,
  readingPositions,
  readingUnits,
  uploadedSourceClaims,
  workMeta,
  workSources
} from "../../db/schema.js";
import {
  createImageResourceStore,
  type ImageResourceStore
} from "../../files/imageResourceStore.js";
import {
  createSourceFileStore,
  resolveWithinDirectory,
  type SourceFileStore
} from "../../files/sourceFileStore.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { loadWorkContent } from "../content/contentQueries.js";
import { publishConvertedPdfImport } from "./pdfImportPublish.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import {
  claimNextQueued,
  commitRange,
  insertPublicationIntent,
  insertQueuedAttempt,
  markAwaitingReview,
  setProbeResult,
  PDF_IMPORT_ADAPTER_FINGERPRINT
} from "./pdfImportStore.js";
import { remapPublishedPdfWork } from "./pdfWorkRemap.js";

// Re-mapping reads the RETAINED converted payload. It must never reach for the converter — the uploaded
// PDF is gone by then (publication frees the stage), so a re-map that shelled out would be both wrong and
// impossible. Every child-process entry point the PDF adapter could use throws here, so any attempt to
// convert fails the test loudly instead of silently succeeding on a developer machine that has Docling
// installed.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const refuse = (): never => {
    throw new Error("the re-map path must never invoke the PDF converter");
  };
  return { ...actual, execFile: refuse, fork: refuse, spawn: refuse, spawnSync: refuse };
});

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-02T00:00:00.000Z");
const doclingSchema = { name: "DoclingDocument", version: "1.10.0" } as const;

let db: DbClient;
let pglite: PGlite;
let stageRootDir: string;
let sourceFilesDir: string;
let imagesDir: string;
let stageStore: PdfImportStageStore;
let sourceFileStore: SourceFileStore;
let imageResourceStore: ImageResourceStore;
let entrySequence = 0;

const createEntryId = (): string => `remap-entry-${(entrySequence += 1)}`;

beforeEach(async () => {
  entrySequence = 0;
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  stageRootDir = await mkdtemp(join(tmpdir(), "pdf-remap-stage-"));
  sourceFilesDir = await mkdtemp(join(tmpdir(), "pdf-remap-src-"));
  imagesDir = await mkdtemp(join(tmpdir(), "pdf-remap-img-"));
  stageStore = createPdfImportStageStore(stageRootDir);
  sourceFileStore = createSourceFileStore(sourceFilesDir);
  imageResourceStore = createImageResourceStore(imagesDir);
});

afterEach(async () => {
  await pglite.close();
  await rm(stageRootDir, { force: true, recursive: true });
  await rm(sourceFilesDir, { force: true, recursive: true });
  await rm(imagesDir, { force: true, recursive: true });
});

function item(partial: Partial<StructuredDocItem> & { label: string }): StructuredDocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, 5],
    children: [],
    confidence: 0.9,
    pageNumber: 1,
    text: "",
    ...partial
  };
}

function rangePayload(
  body: readonly StructuredDocItem[],
  nativeTextPages: readonly boolean[]
): RangeConversion {
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema,
    pages: nativeTextPages.map((hasNativeText, index) => ({
      hasNativeText,
      pageNumber: index + 1
    })),
    body: body as StructuredDocItem[],
    furniture: [],
    // The retained payload carries the PDF's own bookmark outline, which since #816 is what divides a
    // book into reading units. Re-map replays that same rule, so the fixture declares two top-level
    // divisions and a re-map must rebuild two units — the whole point of rewriting reading units.
    outline: [
      { title: "The Work", level: 1, pageNumber: 1 },
      { title: "Chapter One", level: 1, pageNumber: 1 }
    ]
  };
}

const SAMPLE_BODY: readonly StructuredDocItem[] = [
  item({ label: "title", text: "The Work" }),
  item({ label: "text", text: "An opening paragraph." }),
  item({ label: "section_header", text: "Chapter One" }),
  item({ label: "text", text: "The chapter body." })
];

// Publish a real Work exactly as production does — a staged upload, a #721 attempt driven to
// `awaiting_review` with committed ranges, then `publishConvertedPdfImport` — so the state the re-map
// reads is the real post-publication state: the stage freed, the source file retained, the converted
// payload still in `pdf_import_ranges`.
async function publishWork(
  input: Readonly<{
    attemptId: string;
    body?: readonly StructuredDocItem[];
    fileName?: string;
    now?: Date;
    ocrFingerprint?: string;
    sourceHash?: string;
    stageBytes?: Uint8Array;
  }>
): Promise<string> {
  const sourceHash = input.sourceHash ?? "a".repeat(64);
  const stageBytes = input.stageBytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const { stagePath } = await stageStore.createStage(input.attemptId, stageBytes);
  await insertQueuedAttempt(db, {
    id: input.attemptId,
    userId: DEFAULT_USER_ID,
    sourceHash,
    stagePath,
    ocrLanguage: "en",
    now: NOW
  });
  const runToken = `rt-${input.attemptId}`;
  await claimNextQueued(db, { runToken, fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT, now: NOW });
  await setProbeResult(db, {
    id: input.attemptId,
    runToken,
    totalPages: 1,
    totalRanges: 1,
    now: NOW
  });
  await commitRange(db, {
    attemptId: input.attemptId,
    runToken,
    rangeIndex: 0,
    startPage: 1,
    endPage: 1,
    fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
    payload: rangePayload(input.body ?? SAMPLE_BODY, [true]),
    now: NOW
  });
  await markAwaitingReview(db, input.attemptId, runToken, NOW);
  if (input.ocrFingerprint !== undefined) {
    // An attempt that adopted a validated OCR stage carries the engine fingerprint every block was
    // produced under; re-mapped blocks must keep that provenance.
    await db
      .update(pdfImportAttempts)
      .set({ ocrFingerprint: input.ocrFingerprint })
      .where(eq(pdfImportAttempts.id, input.attemptId));
  }
  await insertPublicationIntent(db, {
    attemptId: input.attemptId,
    enteredTitle: null,
    enteredAuthor: null,
    enteredLanguage: null,
    fileName: input.fileName ?? "reading.pdf"
  });

  let entry = 0;
  let author = 0;
  let source = 0;
  const now = input.now ?? NOW;
  const result = await publishConvertedPdfImport(
    {
      db,
      createAuthorId: () => `${input.attemptId}-author-${(author += 1)}`,
      createEntryId: () => `${input.attemptId}-entry-${(entry += 1)}`,
      createSourceId: () => `${input.attemptId}-source-${(source += 1)}`,
      now: () => now,
      stageStore,
      sourceFileStore,
      imageResourceStore,
      logCleanupFailure: () => {
        throw new Error("unexpected cleanup failure");
      }
    },
    input.attemptId
  );
  if (result.status !== "published") {
    throw new Error(`expected a published Work, got ${result.status}`);
  }
  return result.work.entryId;
}

function deps() {
  return { createEntryId, db };
}

// Everything about the Work a refusal must leave untouched: its metadata (including the revision the
// fence would have bumped), its units, its canonical blocks, their evidence, containment, and any saved
// reading position.
async function workSnapshot(workEntryId: string) {
  return {
    blocks: await db
      .select()
      .from(docBlocks)
      .where(eq(docBlocks.workEntryId, workEntryId))
      .orderBy(docBlocks.readingUnitEntryId, docBlocks.orderIndex),
    evidence: await db
      .select()
      .from(pdfBlockEvidence)
      .where(eq(pdfBlockEvidence.workEntryId, workEntryId))
      .orderBy(pdfBlockEvidence.blockId),
    links: await db
      .select()
      .from(entryLinks)
      .orderBy(entryLinks.fromEntryId, entryLinks.toEntryId, entryLinks.type),
    meta: await db.select().from(workMeta).where(eq(workMeta.entryId, workEntryId)),
    positions: await db
      .select()
      .from(readingPositions)
      .where(eq(readingPositions.workEntryId, workEntryId)),
    units: await db
      .select()
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId))
      .orderBy(readingUnits.orderIndex)
  };
}

// The immutable import record a re-map must never touch: the uploaded source row and its bytes, the
// exact-source claim, the attempt, its publication outcome, and the retained converted payload.
async function provenanceSnapshot(workEntryId: string) {
  return {
    attempts: await db.select().from(pdfImportAttempts).orderBy(pdfImportAttempts.id),
    claims: await db.select().from(uploadedSourceClaims).orderBy(uploadedSourceClaims.sha256),
    publications: await db
      .select()
      .from(pdfImportPublications)
      .orderBy(pdfImportPublications.attemptId),
    ranges: await db
      .select()
      .from(pdfImportRanges)
      .orderBy(pdfImportRanges.attemptId, pdfImportRanges.rangeIndex),
    sources: await db.select().from(workSources).where(eq(workSources.workEntryId, workEntryId))
  };
}

// The Work's readable text, in reading order, AS THE READER RECEIVES IT — read back through the same
// content query the reader uses, so the assertion is about served content rather than raw rows.
async function blockTexts(workEntryId: string): Promise<readonly string[]> {
  const content = await loadWorkContent(db, toEntryId(workEntryId));
  return content.readingUnits.flatMap((unit) =>
    (unit.docBlocks ?? []).map((block) => documentText(block.node as DocumentNodeJSON))
  );
}

// Overwrite every canonical block with garbage, leaving the row shape intact. A re-map that genuinely
// re-derives content from the retained payload restores the real text; one that merely shuffled existing
// rows would keep the garbage.
async function corruptBlocks(workEntryId: string): Promise<void> {
  await db
    .update(docBlocks)
    .set({ nodeJson: { type: "paragraph" }, plaintext: "CORRUPTED" })
    .where(eq(docBlocks.workEntryId, workEntryId));
}

describe("remapPublishedPdfWork", () => {
  it("rebuilds the Work's units and blocks from the retained payload without invoking the converter", async () => {
    const workEntryId = await publishWork({ attemptId: "att-1" });
    const originalTexts = await blockTexts(workEntryId);
    const originalBlockIds = (
      await db
        .select({ id: docBlocks.id })
        .from(docBlocks)
        .where(eq(docBlocks.workEntryId, workEntryId))
    ).map((row) => row.id);
    // Publication already freed the stage, so the uploaded PDF no longer exists to reconvert: the
    // retained ranges are the ONLY possible input.
    const attemptBefore = await db
      .select()
      .from(pdfImportAttempts)
      .where(eq(pdfImportAttempts.id, "att-1"));
    expect(attemptBefore[0]?.stagePath).toBeNull();
    const provenanceBefore = await provenanceSnapshot(workEntryId);
    await corruptBlocks(workEntryId);

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    expect(result).toEqual({
      after: { blocks: 4, units: 2 },
      before: { blocks: 4, units: 2 },
      status: "remapped",
      title: "reading"
    });
    // The canonical text is back, served through the same reader query — re-derived from the payload,
    // not recovered from the corrupted rows.
    expect(await blockTexts(workEntryId)).toEqual(originalTexts);
    expect(originalTexts).toContain("An opening paragraph.");
    // Every block is a freshly minted row; none of the corrupted ones survived.
    const rebuiltIds = (
      await db
        .select({ id: docBlocks.id })
        .from(docBlocks)
        .where(eq(docBlocks.workEntryId, workEntryId))
    ).map((row) => row.id);
    expect(rebuiltIds.filter((id) => originalBlockIds.includes(id))).toEqual([]);
    expect(await db.select().from(docBlocks).where(eq(docBlocks.plaintext, "CORRUPTED"))).toEqual(
      []
    );
    // Units are a dense sequence from zero, and the Work contains exactly them.
    const units = await db
      .select({ entryId: readingUnits.entryId, orderIndex: readingUnits.orderIndex })
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId))
      .orderBy(readingUnits.orderIndex);
    expect(units.map((unit) => unit.orderIndex)).toEqual([0, 1]);
    const workLinks = await db
      .select({ toEntryId: entryLinks.toEntryId })
      .from(entryLinks)
      .where(and(eq(entryLinks.fromEntryId, workEntryId), eq(entryLinks.type, "contains")));
    expect(workLinks.map((link) => link.toEntryId).sort()).toEqual(
      units.map((unit) => unit.entryId).sort()
    );
    // The import record — attempt, publication, claim, source row, retained payload — is byte-identical.
    expect(await provenanceSnapshot(workEntryId)).toEqual(provenanceBefore);
    // Block evidence follows the new blocks: the old rows cascaded away with the blocks they described.
    const evidence = await db
      .select({ blockId: pdfBlockEvidence.blockId, ocrEngine: pdfBlockEvidence.ocrEngine })
      .from(pdfBlockEvidence)
      .where(eq(pdfBlockEvidence.workEntryId, workEntryId));
    expect(evidence.map((row) => row.blockId).sort()).toEqual([...rebuiltIds].sort());
    expect(evidence.every((row) => row.ocrEngine === null)).toBe(true);
    // The fence advanced exactly once, so a writer holding the old revision now loses.
    const meta = await db
      .select({ contentRevision: workMeta.contentRevision })
      .from(workMeta)
      .where(eq(workMeta.entryId, workEntryId));
    expect(meta).toEqual([{ contentRevision: 1 }]);
  });

  it("carries the attempt's OCR provenance onto the re-mapped blocks", async () => {
    const workEntryId = await publishWork({
      attemptId: "att-ocr",
      ocrFingerprint: "tesseract@5.3"
    });

    expect((await remapPublishedPdfWork(deps(), workEntryId)).status).toBe("remapped");

    const evidence = await db
      .select({ ocrEngine: pdfBlockEvidence.ocrEngine, ocrLanguage: pdfBlockEvidence.ocrLanguage })
      .from(pdfBlockEvidence)
      .where(eq(pdfBlockEvidence.workEntryId, workEntryId));
    expect(evidence).toHaveLength(4);
    // The Work language is `en`, so the recorded OCR language is its Tesseract pack, not the raw tag.
    expect(
      evidence.every((row) => row.ocrEngine === "tesseract@5.3" && row.ocrLanguage === "eng")
    ).toBe(true);
  });

  it("leaves the immutable source provenance untouched", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const workEntryId = await publishWork({ attemptId: "att-prov", stageBytes: pdfBytes });
    const sourceRow = (
      await db.select().from(workSources).where(eq(workSources.workEntryId, workEntryId))
    )[0]!;
    const provenanceBefore = await provenanceSnapshot(workEntryId);

    expect((await remapPublishedPdfWork(deps(), workEntryId)).status).toBe("remapped");

    // Same source row, same claim, same attempt, same retained payload — and the retained bytes on disk
    // are still the original upload, untouched by a write that only rebuilds canonical blocks.
    expect(await provenanceSnapshot(workEntryId)).toEqual(provenanceBefore);
    const retained = await readFile(resolveWithinDirectory(sourceFilesDir, sourceRow.filePath!));
    expect(new Uint8Array(retained)).toEqual(pdfBytes);
  });

  it("keeps a reader inside the Work they were reading", async () => {
    const workEntryId = await publishWork({ attemptId: "att-pos" });
    const unitsBefore = await db
      .select({ entryId: readingUnits.entryId })
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId))
      .orderBy(readingUnits.orderIndex);
    const anchorId = (
      await db
        .select({ id: docBlocks.id })
        .from(docBlocks)
        .where(eq(docBlocks.readingUnitEntryId, unitsBefore[1]!.entryId))
        .orderBy(docBlocks.orderIndex)
    )[0]!.id;
    await db.insert(readingPositions).values({
      anchorBlockEntryId: anchorId,
      unitEntryId: unitsBefore[1]!.entryId,
      updatedAt: NOW,
      userId: DEFAULT_USER_ID,
      workEntryId
    });

    expect((await remapPublishedPdfWork(deps(), workEntryId)).status).toBe("remapped");

    // The reader is still in the Work, on a unit that exists, at the same relative depth. Their anchor
    // block did not survive the rebuild, so it is dropped rather than left dangling.
    const unitsAfter = await db
      .select({ entryId: readingUnits.entryId })
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId))
      .orderBy(readingUnits.orderIndex);
    const positions = await db
      .select({
        anchorBlockEntryId: readingPositions.anchorBlockEntryId,
        unitEntryId: readingPositions.unitEntryId
      })
      .from(readingPositions)
      .where(eq(readingPositions.workEntryId, workEntryId));
    expect(positions).toEqual([{ anchorBlockEntryId: null, unitEntryId: unitsAfter[1]!.entryId }]);
  });

  it("re-maps from the attempt that originally published the Work, not a later reopen", async () => {
    // A re-upload of identical bytes reopens the same Work and links a SECOND publication to it (#706).
    // That later attempt's payload describes the same source but need not be the one the Work was built
    // from, so the re-map must follow the earliest publication.
    const workEntryId = await publishWork({ attemptId: "att-first" });
    await publishWork({
      attemptId: "att-second",
      body: [item({ label: "text", text: "A truncated re-upload." })],
      now: LATER
    });
    expect(
      await db
        .select({ attemptId: pdfImportPublications.attemptId })
        .from(pdfImportPublications)
        .where(eq(pdfImportPublications.workEntryId, workEntryId))
    ).toHaveLength(2);

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    expect(result).toMatchObject({ after: { blocks: 4, units: 2 }, status: "remapped" });
    expect(await blockTexts(workEntryId)).toContain("An opening paragraph.");
  });

  it("falls back to the current adapter fingerprint when the attempt recorded none", async () => {
    const workEntryId = await publishWork({ attemptId: "att-nofp" });
    await db
      .update(pdfImportAttempts)
      .set({ adapterFingerprint: null })
      .where(eq(pdfImportAttempts.id, "att-nofp"));

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    expect(result).toMatchObject({ after: { blocks: 4, units: 2 }, status: "remapped" });
  });

  it("refuses a Work whose content a human has corrected", async () => {
    const workEntryId = await publishWork({ attemptId: "att-corrected" });
    const correctedAt = new Date("2026-03-03T04:05:06.000Z");
    await db
      .update(workMeta)
      .set({ manualCorrectionsAt: correctedAt })
      .where(eq(workMeta.entryId, workEntryId));
    const before = await workSnapshot(workEntryId);

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    // Named, with the instant of the correction, so the operator knows exactly what they would destroy.
    expect(result).toEqual({ correctedAt, status: "manually_corrected", title: "reading" });
    expect(await workSnapshot(workEntryId)).toEqual(before);
  });

  it("refuses when the attempt retains no converted ranges", async () => {
    const workEntryId = await publishWork({ attemptId: "att-empty" });
    await db.delete(pdfImportRanges).where(eq(pdfImportRanges.attemptId, "att-empty"));
    const before = await workSnapshot(workEntryId);

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    // Refused by name rather than replaying an empty document, which would have emptied a readable Work.
    expect(result).toEqual({
      attemptId: "att-empty",
      status: "no_retained_ranges",
      title: "reading"
    });
    expect(await workSnapshot(workEntryId)).toEqual(before);
  });

  it("refuses when the retained payload no longer maps to a publishable document", async () => {
    const workEntryId = await publishWork({ attemptId: "att-refused" });
    // The same payload, now describing a page with no native text: today's mapper refuses it as needing
    // OCR. A refusal must never make a readable Work unreadable.
    await db
      .update(pdfImportRanges)
      .set({ payload: rangePayload(SAMPLE_BODY, [false]) })
      .where(eq(pdfImportRanges.attemptId, "att-refused"));
    const before = await workSnapshot(workEntryId);

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    expect(result).toEqual({
      mappingStatus: "ocr_validation_failed",
      status: "mapping_refused",
      title: "reading"
    });
    expect(await workSnapshot(workEntryId)).toEqual(before);
  });

  it("refuses when the retained payload now maps to no content at all", async () => {
    const workEntryId = await publishWork({ attemptId: "att-nocontent" });
    await db
      .update(pdfImportRanges)
      .set({ payload: rangePayload([], [true]) })
      .where(eq(pdfImportRanges.attemptId, "att-nocontent"));
    const before = await workSnapshot(workEntryId);

    const result = await remapPublishedPdfWork(deps(), workEntryId);

    expect(result).toEqual({
      mappingStatus: "no_content",
      status: "mapping_refused",
      title: "reading"
    });
    expect(await workSnapshot(workEntryId)).toEqual(before);
  });

  it("refuses a Work that was not published from a PDF import", async () => {
    await db.insert(entries).values({ id: "manual-work", type: "work" });
    await db.insert(authors).values({ id: "author-x", name: "A" });
    await db.insert(workMeta).values({
      authorId: "author-x",
      entryId: "manual-work",
      language: "en",
      origin: "manual",
      title: "Hand-written",
      workType: "essay"
    });

    const result = await remapPublishedPdfWork(deps(), "manual-work");

    expect(result).toEqual({ status: "not_pdf_imported", title: "Hand-written" });
  });

  it("refuses an unknown Work", async () => {
    expect(await remapPublishedPdfWork(deps(), "no-such-work")).toEqual({
      status: "work_not_found"
    });
  });

  it("loses the content-revision race to a concurrent writer and writes nothing", async () => {
    const workEntryId = await publishWork({ attemptId: "att-race" });
    const before = await workSnapshot(workEntryId);
    // A concurrent editor commits between the re-map's read and its write, exactly as the fence exists to
    // catch: the revision the re-map loaded is stale by the time its transaction opens.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (callback: unknown, ...rest: unknown[]) => {
            await db
              .update(workMeta)
              .set({ contentRevision: sql`${workMeta.contentRevision} + 1` })
              .where(eq(workMeta.entryId, workEntryId));
            return (target.transaction as (...args: unknown[]) => unknown)(callback, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as DbClient;

    const result = await remapPublishedPdfWork({ createEntryId, db: racing }, workEntryId);

    expect(result).toEqual({ status: "conflict", title: "reading" });
    // The winner's revision bump stands; nothing else about the Work changed.
    const after = await workSnapshot(workEntryId);
    expect(after.meta).toEqual([{ ...before.meta[0]!, contentRevision: 1 }]);
    expect({ ...after, meta: [] }).toEqual({ ...before, meta: [] });
  });
});
