import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  type RangeConversion,
  type StructuredDocItem
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { pdfBlockEvidence, pdfImportPublications } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { loadWorkContent } from "../content/contentQueries.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import type { PdfImportActiveRuns } from "./pdfImportRunner.js";
import {
  beginPdfImport,
  publishConvertedPdfImport,
  type PdfImportPublishDependencies
} from "./pdfImportPublish.js";
import type { PdfImportCommandDependencies } from "./pdfImportCommands.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
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
  await setProbeResult(db, { id: input.id, runToken, totalPages: input.totalPages, totalRanges: 1, now: NOW });
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

// Insert a queued attempt and drive it to `converted` in one step.
async function driveToConverted(
  db: DbClient,
  input: Readonly<{ id: string; sourceHash: string; payload: RangeConversion; totalPages: number }>
): Promise<void> {
  await insertQueuedAttempt(db, {
    id: input.id,
    userId: DEFAULT_USER_ID,
    sourceHash: input.sourceHash,
    stagePath: `stage-${input.id}`,
    now: NOW
  });
  await driveQueuedToConverted(db, { id: input.id, payload: input.payload, totalPages: input.totalPages });
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
    now: () => NOW
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
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  afterEach(() => {
    // PGlite is in-memory per test; nothing to close explicitly for the drizzle client.
  });

  it("publishes a mapped converted attempt into a canonical Work that surfaces in the reader", async () => {
    await driveToConverted(db, {
      id: "att-1",
      sourceHash: "a".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
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
    const works = await db.select().from(pdfImportPublications).where(eq(pdfImportPublications.attemptId, "att-5"));
    expect(works).toHaveLength(1);
  });

  it("skips an attempt that was never started through beginPdfImport (no publication intent)", async () => {
    await driveToConverted(db, {
      id: "att-6",
      sourceHash: "f".repeat(64),
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    expect(await publishConvertedPdfImport(publishDeps(db), "att-6")).toEqual({ status: "skipped" });
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
    expect(await publishConvertedPdfImport(publishDeps(db), "att-7")).toEqual({ status: "not_ready" });
  });

  it("reopens the owning Work for identical bytes instead of publishing a duplicate", async () => {
    const sourceHash = "1".repeat(64);
    await driveToConverted(db, { id: "att-8a", sourceHash, payload: rangePayload(SAMPLE_BODY, [true]), totalPages: 1 });
    await insertPublicationIntent(db, {
      attemptId: "att-8a",
      enteredTitle: "First",
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "dup.pdf"
    });
    await driveToConverted(db, { id: "att-8b", sourceHash, payload: rangePayload(SAMPLE_BODY, [true]), totalPages: 1 });
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
  });
});

describe("beginPdfImport", () => {
  let db: DbClient;
  let rootDir: string;
  let stageStore: PdfImportStageStore;

  beforeEach(async () => {
    db = await buildDb();
    rootDir = await mkdtemp(join(tmpdir(), "pdf-import-begin-"));
    stageStore = createPdfImportStageStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  function startDeps(): PdfImportCommandDependencies {
    let id = 0;
    return {
      activeRuns: { register: vi.fn(), abort: vi.fn(), clear: vi.fn() } satisfies PdfImportActiveRuns,
      createAttemptId: () => `att-${(id += 1)}`,
      db,
      logCleanupFailure: vi.fn(),
      now: () => NOW,
      stageStore
    };
  }

  it("queues a fresh attempt and records the learner's capture-time intent", async () => {
    const result = await beginPdfImport(
      { db, start: startDeps() },
      {
        userId: DEFAULT_USER_ID,
        bytes: new Uint8Array([1, 2, 3]),
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

  it("reopens the owning Work when identical bytes were already published, without staging a new attempt", async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const first = await beginPdfImport(
      { db, start: startDeps() },
      { userId: DEFAULT_USER_ID, bytes, fileName: "same.pdf" }
    );
    if (first.outcome !== "queued") {
      throw new Error("expected first upload to queue");
    }
    await driveQueuedToConverted(db, {
      id: first.started.attemptId,
      payload: rangePayload(SAMPLE_BODY, [true]),
      totalPages: 1
    });
    const work = published(await publishConvertedPdfImport(publishDeps(db), first.started.attemptId));

    const second = await beginPdfImport(
      { db, start: startDeps() },
      { userId: DEFAULT_USER_ID, bytes, fileName: "same-again.pdf" }
    );
    if (second.outcome !== "reopened") {
      throw new Error(`expected reopened, got ${second.outcome}`);
    }
    expect(second.work.entryId).toBe(work.work.entryId);
  });
});
