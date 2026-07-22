import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  parseRangeConversion,
  type RangeConversion,
  type StructuredDocItem
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  entries,
  pdfBlockEvidence,
  pdfImportAttempts,
  pdfImportPublications,
  uploadedSourceClaims,
  workMeta,
  workSources
} from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import {
  createSourceFileStore,
  resolveWithinDirectory,
  type SourceFileStore
} from "../../files/sourceFileStore.js";
import { loadWorkContent } from "../content/contentQueries.js";
import {
  createPdfImportStageStore,
  PdfUploadTooLargeError,
  type PdfImportStageStore
} from "./pdfImportStage.js";
import type { PdfImportActiveRuns } from "./pdfImportRunner.js";
import {
  beginPdfImport,
  publishConvertedPdfImport,
  type PdfImportPublishDependencies
} from "./pdfImportPublish.js";
import { bornDigitalPreviewRangePayload } from "./pdfImportSampleDocument.js";
import type { PdfImportCommandDependencies } from "./pdfImportCommands.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
  getAttemptById,
  getPublication,
  insertPublicationIntent,
  insertQueuedAttempt,
  markConverted,
  setProbeResult
} from "./pdfImportStore.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const doclingSchema = { name: "DoclingDocument", version: "1.10.0" } as const;

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

// Shared per-test harness: a fresh DB plus real attempt-stage and source-file stores backed by temp
// directories, so publication reads the retained staged bytes and persists the original PDF through the
// immutable source-file boundary exactly as it does in the composition root.
type CleanupFailure = Readonly<{ attemptId: string; stagePath: string; reason: string }>;
let db: DbClient;
let stageRootDir: string;
let sourceFilesDir: string;
let stageStore: PdfImportStageStore;
let sourceFileStore: SourceFileStore;
let cleanupFailures: CleanupFailure[];

beforeEach(async () => {
  db = await buildDb();
  stageRootDir = await mkdtemp(join(tmpdir(), "pdf-import-publish-stage-"));
  sourceFilesDir = await mkdtemp(join(tmpdir(), "pdf-import-publish-src-"));
  stageStore = createPdfImportStageStore(stageRootDir);
  sourceFileStore = createSourceFileStore(sourceFilesDir);
  cleanupFailures = [];
});

afterEach(async () => {
  await rm(stageRootDir, { force: true, recursive: true });
  await rm(sourceFilesDir, { force: true, recursive: true });
});

function item(partial: Partial<StructuredDocItem> & { label: string }): StructuredDocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, 5],
    children: [],
    confidence: 0.9,
    label: partial.label,
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
    furniture: []
  };
}

// Drive an already-queued attempt through the #721 state machine to `converted` with a single committed
// range, so the publication layer has a real converted attempt + persisted ranges to reconstruct.
async function driveQueuedToConverted(
  db: DbClient,
  input: Readonly<{ id: string; payload: RangeConversion; totalPages: number }>
): Promise<void> {
  const runToken = `rt-${input.id}`;
  await claimNextQueued(db, { runToken, fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT, now: NOW });
  await setProbeResult(db, {
    id: input.id,
    runToken,
    totalPages: input.totalPages,
    totalRanges: 1,
    now: NOW
  });
  await commitRange(db, {
    attemptId: input.id,
    runToken,
    rangeIndex: 0,
    startPage: 1,
    endPage: input.totalPages,
    fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
    payload: input.payload,
    now: NOW
  });
  await markConverted(db, input.id, runToken, NOW);
}

// Insert a queued attempt, stage its real bytes (so publication can retain them as provenance), and drive
// it to `converted` in one step.
async function driveToConverted(
  db: DbClient,
  input: Readonly<{
    id: string;
    sourceHash: string;
    payload: RangeConversion;
    totalPages: number;
    stageBytes?: Uint8Array;
  }>
): Promise<void> {
  const { stagePath } = await stageStore.createStage(
    input.id,
    input.stageBytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46])
  );
  await insertQueuedAttempt(db, {
    id: input.id,
    userId: DEFAULT_USER_ID,
    sourceHash: input.sourceHash,
    stagePath,
    now: NOW
  });
  await driveQueuedToConverted(db, {
    id: input.id,
    payload: input.payload,
    totalPages: input.totalPages
  });
}

function publishDeps(db: DbClient): PdfImportPublishDependencies {
  let entry = 0;
  let author = 0;
  let source = 0;
  return {
    db,
    createAuthorId: () => `author-${(author += 1)}`,
    createEntryId: () => `entry-${(entry += 1)}`,
    createSourceId: () => `source-${(source += 1)}`,
    now: () => NOW,
    stageStore,
    sourceFileStore,
    logCleanupFailure: (event) => {
      cleanupFailures.push(event);
    }
  };
}

function published(result: Awaited<ReturnType<typeof publishConvertedPdfImport>>) {
  if (result.status !== "published") {
    throw new Error(`expected published, got ${result.status}`);
  }
  return result;
}

const SAMPLE_BODY: readonly StructuredDocItem[] = [
  item({ label: "title", text: "The Work" }),
  item({ label: "text", text: "An opening paragraph." }),
  item({ label: "section_header", text: "Chapter One" }),
  item({ label: "text", text: "The chapter body." })
];

describe("publishConvertedPdfImport", () => {
  it("publishes a mapped converted attempt into a canonical Work that surfaces in the reader", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    await driveToConverted(db, {
      id: "att-1",
      sourceHash: "a".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1,
      stageBytes: pdfBytes
    });
    await insertPublicationIntent(db, {
      attemptId: "att-1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "reading.pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-1"));
    expect(result.reopened).toBe(false);
    // Filename stem fallback (no directory, no extension), neutral author + language defaults.
    expect(result.work.title).toBe("reading");
    expect(result.work.language).toBe("en");

    const content = await loadWorkContent(db, result.work.entryId);
    expect(content).not.toBeNull();
    const units = content!.readingUnits;
    expect(units.length).toBeGreaterThanOrEqual(2);
    const totalDocBlocks = units.reduce((total, unit) => total + (unit.docBlocks?.length ?? 0), 0);
    expect(totalDocBlocks).toBe(4);

    const publication = await getPublication(db, "att-1");
    expect(publication?.workEntryId).toBe(result.work.entryId);
    expect(publication?.ocrRequiredPages).toBeNull();

    // Provenance retention (PRODUCT.md): the original uploaded PDF is persisted through the source-file
    // boundary — the Work's source row keeps a non-null file_path whose bytes match the upload — and the
    // now-redundant stage is freed without a cleanup failure.
    const sources = await db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, result.work.entryId));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.filePath).not.toBeNull();
    const retained = await readFile(resolveWithinDirectory(sourceFilesDir, sources[0]!.filePath!));
    expect(new Uint8Array(retained)).toEqual(pdfBytes);
    await expect(stat(stageStore.openStage("att-1").path)).rejects.toThrow();
    expect(cleanupFailures).toEqual([]);
    // The stage binding is cleared once the bytes are durable, so status no longer reports it bound.
    expect((await getAttemptById(db, "att-1"))?.stagePath).toBeNull();
  });

  it("publishes and surfaces an unknown-only born-digital PDF whose page maps entirely to unknown nodes (#702)", async () => {
    // Every construct on the page is unmappable, so the body becomes one null-title Start unit of only
    // `unknown` nodes. Publication must still commit the Work and its post-commit content assertion must
    // pass — the reader shows the inert `unknown` fallback so nothing is silently dropped. Before the
    // surfacing fix, `loadWorkContent` hid the unknown-only unit, so `assertContentPersisted` threw after
    // the Work/source/claim were already committed, orphaning a Work the reader could never show.
    await driveToConverted(db, {
      id: "att-unknown",
      sourceHash: "e".repeat(64),
      payload: rangePayload([item({ label: "chart", text: "An unmapped chart." })], [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-unknown",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "chart.pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-unknown"));

    const content = await loadWorkContent(db, result.work.entryId);
    const served = content.readingUnits.flatMap((unit) => unit.docBlocks ?? []);
    expect(served.map((block) => block.type)).toEqual(["unknown"]);
    expect(
      String((served[0]?.node as { attrs?: Record<string, unknown> }).attrs?.["html"])
    ).toContain("An unmapped chart.");
  });

  it("prefers entered metadata over the filename fallback", async () => {
    await driveToConverted(db, {
      id: "att-2",
      sourceHash: "b".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-2",
      enteredTitle: "Chosen Title",
      enteredAuthor: "Jane Author",
      enteredLanguage: "zh-CN",
      fileName: "ignored.pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-2"));
    expect(result.work.title).toBe("Chosen Title");
    expect(result.work.language).toBe("zh-CN");
  });

  it("writes additive per-block evidence keyed to the persisted blocks", async () => {
    await driveToConverted(db, {
      id: "att-3",
      sourceHash: "c".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-3",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "evidence.pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-3"));
    const rows = await db
      .select()
      .from(pdfBlockEvidence)
      .where(eq(pdfBlockEvidence.workEntryId, result.work.entryId));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.page === 1)).toBe(true);
    expect(rows.some((row) => row.label === "section_header")).toBe(true);
  });

  it("records a typed OCR-required outcome without creating a Work when a page lacks native text", async () => {
    await driveToConverted(db, {
      id: "att-4",
      sourceHash: "d".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true, false, false]),
      totalPages: 3
    });
    await insertPublicationIntent(db, {
      attemptId: "att-4",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "scanned.pdf"
    });

    const result = await publishConvertedPdfImport(publishDeps(db), "att-4");
    expect(result).toEqual({ pagesNeedingOcr: 2, status: "ocr_required" });
    const publication = await getPublication(db, "att-4");
    expect(publication?.ocrRequiredPages).toBe(2);
    expect(publication?.workEntryId).toBeNull();
    // No Work is published, so no source file is retained and the redundant stage is freed cleanly.
    expect(await db.select().from(workSources)).toHaveLength(0);
    await expect(stat(stageStore.openStage("att-4").path)).rejects.toThrow();
    expect(cleanupFailures).toEqual([]);
    // The stage binding is cleared on the OCR-required outcome too, so status reports it unbound.
    expect((await getAttemptById(db, "att-4"))?.stagePath).toBeNull();
  });

  it("is idempotent: a second publish of a resolved attempt is a no-op", async () => {
    await driveToConverted(db, {
      id: "att-5",
      sourceHash: "e".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-5",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "once.pdf"
    });
    const deps = publishDeps(db);
    published(await publishConvertedPdfImport(deps, "att-5"));

    expect(await publishConvertedPdfImport(deps, "att-5")).toEqual({ status: "already_published" });
    const works = await db
      .select()
      .from(pdfImportPublications)
      .where(eq(pdfImportPublications.attemptId, "att-5"));
    expect(works).toHaveLength(1);
  });

  it("skips an attempt that was never started through beginPdfImport (no publication intent)", async () => {
    await driveToConverted(db, {
      id: "att-6",
      sourceHash: "f".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    expect(await publishConvertedPdfImport(publishDeps(db), "att-6")).toEqual({
      status: "skipped"
    });
  });

  it("reports not_ready when the attempt is not converted", async () => {
    await insertQueuedAttempt(db, {
      id: "att-7",
      userId: DEFAULT_USER_ID,
      sourceHash: "0".repeat(64),
      stagePath: "stage-att-7",
      now: NOW
    });
    await insertPublicationIntent(db, {
      attemptId: "att-7",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "pending.pdf"
    });
    expect(await publishConvertedPdfImport(publishDeps(db), "att-7")).toEqual({
      status: "not_ready"
    });
  });

  it("reopens the owning Work for identical bytes instead of publishing a duplicate", async () => {
    const sourceHash = "1".repeat(64);
    await driveToConverted(db, {
      id: "att-8a",
      sourceHash,
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-8a",
      enteredTitle: "First",
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "dup.pdf"
    });
    await driveToConverted(db, {
      id: "att-8b",
      sourceHash,
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-8b",
      enteredTitle: "Second",
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "dup.pdf"
    });

    const deps = publishDeps(db);
    const first = published(await publishConvertedPdfImport(deps, "att-8a"));
    const second = published(await publishConvertedPdfImport(deps, "att-8b"));
    expect(second.reopened).toBe(true);
    expect(second.work.entryId).toBe(first.work.entryId);

    const publicationB = await getPublication(db, "att-8b");
    expect(publicationB?.workEntryId).toBe(first.work.entryId);

    // The reopen persists no second source file (the winning Work already retains its bytes), and both
    // attempts' redundant stages are freed cleanly.
    const sources = await db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, first.work.entryId));
    expect(sources).toHaveLength(1);
    await expect(stat(stageStore.openStage("att-8a").path)).rejects.toThrow();
    await expect(stat(stageStore.openStage("att-8b").path)).rejects.toThrow();
    expect(cleanupFailures).toEqual([]);
  });

  it("releases the staged source file and reopens the winner when an identical claim lands mid-stage", async () => {
    const sourceHash = "2".repeat(64);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);
    await driveToConverted(db, {
      id: "att-race",
      sourceHash,
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1,
      stageBytes: pdfBytes
    });
    await insertPublicationIntent(db, {
      attemptId: "att-race",
      enteredTitle: "Loser",
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "race.pdf"
    });

    await db.insert(authors).values({ id: "author-winner", name: "Race Winner", nameKey: null });
    const deleteSourceFile = vi.fn((path: string) => sourceFileStore.deleteSourceFile(path));
    // A concurrent winner commits its Work + claim for the same hash after our initial miss but before
    // our own transaction inserts the claim — modelled by committing it during the source-file write.
    const racingStore: SourceFileStore = {
      ...sourceFileStore,
      deleteSourceFile,
      writePdfSource: async (args) => {
        const written = await sourceFileStore.writePdfSource(args);
        await db.insert(entries).values({ id: "work-winner", type: "work" });
        await db.insert(workMeta).values({
          authorId: "author-winner",
          entryId: "work-winner",
          language: "en",
          origin: "imported",
          title: "PDF Winner",
          workType: "book"
        });
        await db
          .insert(uploadedSourceClaims)
          .values({ sha256: sourceHash, workEntryId: "work-winner" });
        return written;
      }
    };

    const deps: PdfImportPublishDependencies = { ...publishDeps(db), sourceFileStore: racingStore };
    const result = published(await publishConvertedPdfImport(deps, "att-race"));
    expect(result.reopened).toBe(true);
    expect(result.work.entryId).toBe("work-winner");

    // The loser's just-written source file was released (never orphaned), and only the winner survives.
    expect(deleteSourceFile).toHaveBeenCalledOnce();
    const works = await db.select().from(workMeta);
    expect(works.map((row) => row.entryId)).toEqual(["work-winner"]);
    expect(await db.select().from(workSources)).toHaveLength(0);
    // The now-redundant stage is still freed cleanly after the reopen.
    await expect(stat(stageStore.openStage("att-race").path)).rejects.toThrow();
    expect(cleanupFailures).toEqual([]);
  });

  const cleanupFailureCases = [
    { name: "an Error cause", id: "att-clean-err", rejection: new Error("stage locked") },
    { name: "a non-Error cause", id: "att-clean-str", rejection: "stage locked" }
  ] as const;
  for (const { name, id, rejection } of cleanupFailureCases) {
    it(`publishes with retained source bytes and surfaces a post-publish stage cleanup failure (${name})`, async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      await driveToConverted(db, {
        id,
        sourceHash: "7".repeat(64),
        payload: rangePayload(SAMPLE_BODY, [true]),
        totalPages: 1,
        stageBytes: pdfBytes
      });
      await insertPublicationIntent(db, {
        attemptId: id,
        enteredTitle: null,
        enteredAuthor: null,
        enteredLanguage: null,
        fileName: "locked.pdf"
      });
      const deps: PdfImportPublishDependencies = {
        ...publishDeps(db),
        stageStore: {
          readStage: stageStore.readStage,
          removeStage: () => Promise.reject(rejection)
        }
      };

      const result = published(await publishConvertedPdfImport(deps, id));
      // The Work still publishes with its source bytes durably retained, even though the now-redundant
      // stage could not be freed.
      const sources = await db
        .select()
        .from(workSources)
        .where(eq(workSources.workEntryId, result.work.entryId));
      expect(sources[0]!.filePath).not.toBeNull();
      const retained = await readFile(
        resolveWithinDirectory(sourceFilesDir, sources[0]!.filePath!)
      );
      expect(new Uint8Array(retained)).toEqual(pdfBytes);
      // The cleanup failure is surfaced (never swallowed) and the staged bytes still exist for a retry.
      expect(cleanupFailures).toContainEqual(
        expect.objectContaining({ attemptId: id, reason: "stage locked" })
      );
      await expect(stat(stageStore.openStage(id).path)).resolves.toBeDefined();
      // The stage binding stays set on a removal failure, so status still reports it bound and the
      // cleanup remains retryable rather than orphaning the bytes with no path record.
      expect((await getAttemptById(db, id))?.stagePath).not.toBeNull();
    });
  }

  it("publishes the keyless born-digital preview sample into a multi-section Reader Work", async () => {
    // The composition root feeds this exact payload to the fake runner, so publishing it here proves the
    // shipped preview maps to a real multi-section canonical Work (title + two sections) with no OCR gap.
    const parsed = parseRangeConversion(bornDigitalPreviewRangePayload);
    if (parsed.status !== "ok") {
      throw new Error(`sample payload is not a valid range conversion: ${parsed.status}`);
    }
    await driveToConverted(db, {
      id: "att-sample",
      sourceHash: "9".repeat(64),
      payload: parsed.value,
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-sample",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "preview.pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-sample"));
    const content = await loadWorkContent(db, result.work.entryId);
    const titles = content!.readingUnits.map((unit) => unit.title);
    // Title heading opens the first unit; each section_header starts another — three units in order.
    expect(titles).toEqual(["Born-Digital Preview", "How Import Works", "What Remains"]);
    const publication = await getPublication(db, "att-sample");
    expect(publication?.ocrRequiredPages).toBeNull();
  });

  it("publishes a full-length document in one bounded transaction without exceeding the bind limit", async () => {
    // A generated full-length body with far more paragraphs than a single INSERT's bind-parameter budget
    // allows: publication must batch every bulk insert so the whole large ReadingUnit commits atomically
    // (a rolled-back oversized statement would silently persist zero blocks). Headingless -> one Start unit.
    const paragraphCount = 4000;
    const body: StructuredDocItem[] = [];
    for (let index = 0; index < paragraphCount; index += 1) {
      body.push(
        item({ label: "text", text: `Paragraph number ${index} of the full-length import.` })
      );
    }
    await driveToConverted(db, {
      id: "att-long",
      sourceHash: "8".repeat(64),
      payload: rangePayload(body, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-long",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "long.pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-long"));
    const content = await loadWorkContent(db, result.work.entryId);
    expect(content!.readingUnits).toHaveLength(1);
    const totalDocBlocks = content!.readingUnits.reduce(
      (total, unit) => total + (unit.docBlocks?.length ?? 0),
      0
    );
    expect(totalDocBlocks).toBe(paragraphCount);
    const evidence = await db
      .select()
      .from(pdfBlockEvidence)
      .where(eq(pdfBlockEvidence.workEntryId, result.work.entryId));
    expect(evidence).toHaveLength(paragraphCount);
  });

  it("falls back to a neutral title when the file name has no usable stem", async () => {
    // A dotfile-only name (".pdf") has an empty stem, so neither the entered title nor the stem resolves —
    // the neutral default keeps the Work openable rather than titling it with a raw extension.
    await driveToConverted(db, {
      id: "att-untitled",
      sourceHash: "2".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-untitled",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: ".pdf"
    });

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-untitled"));
    expect(result.work.title).toBe("Untitled PDF");
  });

  it("publishes a converted attempt whose adapter fingerprint and page total were never recorded", async () => {
    // Defense-in-depth: a converted row is expected to carry both, but if either column is null the
    // publisher reconstructs with the current adapter fingerprint and a zero page count rather than failing.
    await driveToConverted(db, {
      id: "att-nullcols",
      sourceHash: "3".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    await insertPublicationIntent(db, {
      attemptId: "att-nullcols",
      enteredTitle: "Recovered",
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "recovered.pdf"
    });
    await db
      .update(pdfImportAttempts)
      .set({ adapterFingerprint: null, totalPages: null })
      .where(eq(pdfImportAttempts.id, "att-nullcols"));

    const result = published(await publishConvertedPdfImport(publishDeps(db), "att-nullcols"));
    expect(result.work.title).toBe("Recovered");
    const content = await loadWorkContent(db, result.work.entryId);
    expect(content!.readingUnits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("beginPdfImport", () => {
  async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  function startDeps(): PdfImportCommandDependencies {
    let id = 0;
    return {
      activeRuns: {
        register: vi.fn(),
        abort: vi.fn(),
        clear: vi.fn()
      } satisfies PdfImportActiveRuns,
      createAttemptId: () => `att-${(id += 1)}`,
      db,
      logCleanupFailure: vi.fn(),
      now: () => NOW,
      stageStore
    };
  }

  // A db whose insert into pdf_import_publications fails, to drive the publication-intent write failure
  // path. The queued-attempt insert and the dedup SELECT pass straight through to the real db; only the
  // intent insert throws. Applied recursively to the transaction handle so the failure lands inside the
  // atomic start transaction (and, for a non-atomic regression, on the top-level db too).
  function failIntentInsert(executor: DbClient): DbClient {
    return new Proxy(executor, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (cb: (tx: DbClient) => unknown, ...rest: unknown[]) =>
            (target.transaction as (...args: unknown[]) => unknown)(
              (tx: DbClient) => cb(failIntentInsert(tx)),
              ...rest
            );
        }
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === pdfImportPublications) {
              throw new Error("publication intent insert failed");
            }
            return (target.insert as (value: unknown) => unknown)(table);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as DbClient;
  }

  it("rolls back the queued attempt and discards the stage when the publication-intent insert fails", async () => {
    // The attempt row and its #702 intent must start atomically: if the intent insert fails after the
    // queued row is inserted, the row must roll back too — otherwise a queued attempt with no intent
    // survives, converts, and later publishes as `skipped`.
    const failingDb = failIntentInsert(db);
    const start: PdfImportCommandDependencies = { ...startDeps(), db: failingDb };

    await expect(
      beginPdfImport(
        { db: failingDb, start },
        {
          userId: DEFAULT_USER_ID,
          source: streamOf(new Uint8Array([5, 5, 5])),
          maxBytes: 1_000,
          fileName: "atomic.pdf"
        }
      )
    ).rejects.toThrow(/publication intent insert failed/u);

    // No orphaned queued attempt and no intent row committed, and the freshly-staged bytes were discarded.
    expect(await db.select().from(pdfImportAttempts)).toHaveLength(0);
    expect(await db.select().from(pdfImportPublications)).toHaveLength(0);
    await expect(stat(stageStore.openStage("att-1").path)).rejects.toThrow();
  });

  it("streams a fresh attempt and records the learner's capture-time intent", async () => {
    const result = await beginPdfImport(
      { db, start: startDeps() },
      {
        userId: DEFAULT_USER_ID,
        // The upload arrives as separate chunks: beginPdfImport streams them into the stage without
        // buffering the whole file to hash it.
        source: streamOf(new Uint8Array([1, 2]), new Uint8Array([3])),
        maxBytes: 1_000,
        fileName: "upload.pdf",
        enteredTitle: "  Trimmed Title  ",
        enteredAuthor: "   ",
        enteredLanguage: null
      }
    );
    if (result.outcome !== "queued") {
      throw new Error(`expected queued, got ${result.outcome}`);
    }
    const publication = await getPublication(db, result.started.attemptId);
    expect(publication?.fileName).toBe("upload.pdf");
    // Entered values are trimmed; a whitespace-only author collapses to null.
    expect(publication?.enteredTitle).toBe("Trimmed Title");
    expect(publication?.enteredAuthor).toBeNull();
  });

  it("reports an empty upload as empty and stages nothing durable", async () => {
    const result = await beginPdfImport(
      { db, start: startDeps() },
      { userId: DEFAULT_USER_ID, source: streamOf(), maxBytes: 1_000, fileName: "empty.pdf" }
    );
    expect(result.outcome).toBe("empty");
    // The just-staged empty stage was discarded — no attempt row and no lingering bytes.
    await expect(stat(stageStore.openStage("att-1").path)).rejects.toThrow();
  });

  it("propagates a too-large upload as PdfUploadTooLargeError", async () => {
    await expect(
      beginPdfImport(
        { db, start: startDeps() },
        {
          userId: DEFAULT_USER_ID,
          source: streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
          maxBytes: 2,
          fileName: "big.pdf"
        }
      )
    ).rejects.toBeInstanceOf(PdfUploadTooLargeError);
  });

  it("reopens the owning Work when identical bytes were already published, without staging a new attempt", async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const first = await beginPdfImport(
      { db, start: startDeps() },
      { userId: DEFAULT_USER_ID, source: streamOf(bytes), maxBytes: 1_000, fileName: "same.pdf" }
    );
    if (first.outcome !== "queued") {
      throw new Error("expected first upload to queue");
    }
    await driveQueuedToConverted(db, {
      id: first.started.attemptId,
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    const work = published(
      await publishConvertedPdfImport(publishDeps(db), first.started.attemptId)
    );

    const second = await beginPdfImport(
      { db, start: startDeps() },
      {
        userId: DEFAULT_USER_ID,
        source: streamOf(bytes),
        maxBytes: 1_000,
        fileName: "same-again.pdf"
      }
    );
    if (second.outcome !== "reopened") {
      throw new Error(`expected reopened, got ${second.outcome}`);
    }
    expect(second.work.entryId).toBe(work.work.entryId);
  });
});
