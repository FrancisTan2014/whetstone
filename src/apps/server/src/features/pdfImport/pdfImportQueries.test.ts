import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RANGE_CONVERSION_SCHEMA_VERSION, type RangeConversion } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { getPdfImportStatus } from "./pdfImportQueries.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
  insertQueuedAttempt,
  markFailed,
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
      now: new Date()
    });
  }

  it("reports a fresh queued attempt with no probe totals or progress", async () => {
    await seedQueued("a1");
    const status = await getPdfImportStatus(db, DEFAULT_USER_ID, "a1");

    expect(status).toMatchObject({
      attemptId: "a1",
      state: "queued",
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
      totalPages: 4,
      totalRanges: 2,
      completedPages: 2,
      completedRanges: 1,
      adapterFingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT
    });
    expect(status?.heartbeatAt).not.toBeNull();
  });

  it("reports a typed failure and a released stage once failed", async () => {
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

    const status = await getPdfImportStatus(db, DEFAULT_USER_ID, "a1");
    expect(status).toMatchObject({
      state: "failed",
      failure: { kind: "malformed", message: "bad", remedy: "re-stage" },
      stage: { bound: false },
      heartbeatAt: null
    });
  });

  it("returns null for a missing attempt", async () => {
    expect(await getPdfImportStatus(db, DEFAULT_USER_ID, "missing")).toBeNull();
  });

  it("returns null for another user's attempt (no existence leak)", async () => {
    await seedQueued("a1");
    expect(await getPdfImportStatus(db, "someone-else", "a1")).toBeNull();
  });
});
