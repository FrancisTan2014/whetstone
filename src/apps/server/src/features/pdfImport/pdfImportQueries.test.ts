import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RANGE_CONVERSION_SCHEMA_VERSION, type RangeConversion } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { getPdfImportStatus, buildPdfImportPublicationOutcome } from "./pdfImportQueries.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  clearStagePath,
  commitRange,
  insertPublicationIntent,
  insertQueuedAttempt,
  linkPublishedWork,
  markFailed,
  markPublicationImagesUnsupported,
  markPublicationNoContent,
  markPublicationOcrValidationFailed,
  setProbeResult
} from "./pdfImportStore.js";

const doclingSchema = { name: "docling-core", version: "1.10.0" } as const;

function payloadForPages(startPage: number, endPage: number): RangeConversion {
  const pages = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pages.push({ pageNumber: page, hasNativeText: true });
  }
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema,
    pages,
    body: [],
    furniture: []
  };
}

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

describe("getPdfImportStatus", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  afterEach(() => {
    // PGlite is in-memory per test; nothing to tear down.
  });

  async function seedQueued(id: string): Promise<void> {
    await insertQueuedAttempt(db, {
      id,
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath: id,
      ocrLanguage: "en",
      now: new Date()
    });
  }

  it("reports a fresh queued attempt with no probe totals or progress", async () => {
    await seedQueued("a1");
    const status = await getPdfImportStatus(db, DEFAULT_USER_ID, "a1");

    expect(status).toMatchObject({
      attemptId: "a1",
      state: "queued",
      phase: null,
      completedPages: 0,
      completedRanges: 0,
      totalPages: null,
      totalRanges: null,
      failure: null,
      heartbeatAt: null,
      stage: { bound: true }
    });
    expect(status?.adapterFingerprint).toBeNull();
  });

  it("reports probe totals, a committed range, and a heartbeat once running", async () => {
    await seedQueued("a1");
    await claimNextQueued(db, {
      runToken: "rt",
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      now: new Date()
    });
    await setProbeResult(db, {
      id: "a1",
      runToken: "rt",
      totalPages: 4,
      totalRanges: 2,
      now: new Date()
    });
    await commitRange(db, {
      attemptId: "a1",
      runToken: "rt",
      rangeIndex: 0,
      startPage: 1,
      endPage: 2,
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      payload: payloadForPages(1, 2),
      now: new Date()
    });

    const status = await getPdfImportStatus(db, DEFAULT_USER_ID, "a1");
    expect(status).toMatchObject({
      state: "running",
      phase: "preflight",
      totalPages: 4,
      totalRanges: 2,
      completedPages: 2,
      completedRanges: 1,
      adapterFingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT
    });
    expect(status?.heartbeatAt).not.toBeNull();
  });

  it("keeps the stage bound on a failed attempt until cleanup releases it", async () => {
    await seedQueued("a1");
    await claimNextQueued(db, {
      runToken: "rt",
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      now: new Date()
    });
    await markFailed(
      db,
      "a1",
      "rt",
      { kind: "malformed", message: "bad", remedy: "re-stage" },
      new Date()
    );

    // Failed keeps the stage bound so a cleanup failure stays visible/retryable.
    const failed = await getPdfImportStatus(db, DEFAULT_USER_ID, "a1");
    expect(failed).toMatchObject({
      state: "failed",
      failure: { kind: "malformed", message: "bad", remedy: "re-stage" },
      stage: { bound: true },
      heartbeatAt: null
    });

    // Only after the bytes are actually removed does the stage report unbound.
    await clearStagePath(db, "a1", new Date());
    const released = await getPdfImportStatus(db, DEFAULT_USER_ID, "a1");
    expect(released?.stage).toEqual({ bound: false });
  });

  it("returns null for a missing attempt", async () => {
    expect(await getPdfImportStatus(db, DEFAULT_USER_ID, "missing")).toBeNull();
  });

  it("returns null for another user's attempt (no existence leak)", async () => {
    await seedQueued("a1");
    expect(await getPdfImportStatus(db, "someone-else", "a1")).toBeNull();
  });
});

describe("buildPdfImportPublicationOutcome", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  async function seedQueued(id: string): Promise<void> {
    await insertQueuedAttempt(db, {
      id,
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath: id,
      ocrLanguage: "en",
      now: new Date()
    });
  }

  it("reports `none` when no publication was ever recorded for the attempt", async () => {
    await seedQueued("a1");
    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({ status: "none" });
  });

  it("reports `ocr_validation_failed` with the page count once an English OCR refusal is recorded", async () => {
    await seedQueued("a1");
    await insertPublicationIntent(db, {
      attemptId: "a1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "scan.pdf"
    });
    await markPublicationOcrValidationFailed(db, "a1", 3, new Date());

    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({
      pagesNeedingOcr: 3,
      status: "ocr_validation_failed"
    });
  });

  it("reports `no_content` once an empty-document refusal is recorded", async () => {
    await seedQueued("a1");
    await insertPublicationIntent(db, {
      attemptId: "a1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "blank.pdf"
    });
    await markPublicationNoContent(db, "a1", new Date());

    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({ status: "no_content" });
  });

  it("reports `image_unsupported` with the image count once an unsupported-image refusal is recorded", async () => {
    await seedQueued("a1");
    await insertPublicationIntent(db, {
      attemptId: "a1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "figures.pdf"
    });
    await markPublicationImagesUnsupported(db, "a1", 2, new Date());

    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({
      status: "image_unsupported",
      unpreservableImages: 2
    });
  });

  it("reports `pending` once an intent exists but neither a Work nor an OCR refusal is resolved", async () => {
    await seedQueued("a1");
    await insertPublicationIntent(db, {
      attemptId: "a1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "pending.pdf"
    });

    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({ status: "pending" });
  });

  it("reports `published` with the linked Work and its figure/outline-gap warning counts (#806, #870)", async () => {
    await seedQueued("a1");
    await insertPublicationIntent(db, {
      attemptId: "a1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "book.pdf"
    });
    await db.insert(entries).values({ id: "work-a1", type: "work" });
    await linkPublishedWork(db, "a1", "work-a1", new Date(), 2, 3, 5);

    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({
      status: "published",
      unresolvedFigureCount: 2,
      headingLevelSources: { label: 3, outline: 5 },
      workEntryId: "work-a1"
    });
  });

  it("reports `published` with zeroed warning counts once a Work with no figures or outline gap links", async () => {
    await seedQueued("a1");
    await insertPublicationIntent(db, {
      attemptId: "a1",
      enteredTitle: null,
      enteredAuthor: null,
      enteredLanguage: null,
      fileName: "clean.pdf"
    });
    await db.insert(entries).values({ id: "work-a1", type: "work" });
    // A Work with nothing to warn about stores every count as null (#806, #870); the outcome still
    // reports 0 rather than null so the Library never has to special-case an absent warning.
    await linkPublishedWork(db, "a1", "work-a1", new Date(), null, null, null);

    expect(await buildPdfImportPublicationOutcome(db, "a1")).toEqual({
      status: "published",
      unresolvedFigureCount: 0,
      headingLevelSources: { label: 0, outline: 0 },
      workEntryId: "work-a1"
    });
  });
});
