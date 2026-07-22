import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parsePdfImportBeginResultDto,
  parsePdfImportViewDto,
  pdfContentType,
  RANGE_CONVERSION_SCHEMA_VERSION,
  type PdfImportStartMetadataDto,
  type RangeConversion,
  type StructuredDocItem
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";
import { publishConvertedPdfImport, type PdfImportPublishDependencies } from "./pdfImportPublish.js";
import type { PdfImportCommandDependencies } from "./pdfImportCommands.js";
import { createPdfImportActiveRuns } from "./pdfImportRunner.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
  markConverted,
  setProbeResult
} from "./pdfImportStore.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const doclingSchema = { name: "DoclingDocument", version: "1.10.0" } as const;

type TestContext = Readonly<{
  db: DbClient;
  rootDir: string;
  server: ReturnType<typeof createServer>;
  stageStore: PdfImportStageStore;
}>;

let context: TestContext;

function structuredItem(label: string, text: string): StructuredDocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, text.length],
    children: [],
    confidence: 0.9,
    label,
    pageNumber: 1,
    text
  };
}

function rangePayload(nativeTextPages: readonly boolean[]): RangeConversion {
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema,
    pages: nativeTextPages.map((hasNativeText, index) => ({ hasNativeText, pageNumber: index + 1 })),
    body: [structuredItem("title", "The Work"), structuredItem("text", "An opening paragraph.")],
    furniture: []
  };
}

function commandDeps(db: DbClient, stageStore: PdfImportStageStore): PdfImportCommandDependencies {
  let id = 0;
  return {
    activeRuns: createPdfImportActiveRuns(),
    createAttemptId: () => `att-${(id += 1)}`,
    db,
    logCleanupFailure: vi.fn(),
    now: () => NOW,
    stageStore
  };
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

function metadataHeader(metadata: Partial<PdfImportStartMetadataDto> & { fileName: string }): string {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");
}

function beginUpload(
  bytes: Buffer,
  header: string | undefined
): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    headers: {
      "content-type": pdfContentType,
      ...(header === undefined ? {} : { "x-pdf-import-metadata": header })
    },
    method: "POST",
    payload: bytes,
    url: "/api/pdf-imports"
  });
}

// Drive the attempt the server just queued through #721 to `converted` with one committed range, so the
// publication layer has a real converted attempt to reconstruct and open as a Work.
async function driveToConverted(
  db: DbClient,
  attemptId: string,
  nativeTextPages: readonly boolean[]
): Promise<void> {
  const runToken = `rt-${attemptId}`;
  const totalPages = nativeTextPages.length;
  await claimNextQueued(db, { runToken, fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT, now: NOW });
  await setProbeResult(db, { id: attemptId, runToken, totalPages, totalRanges: 1, now: NOW });
  await commitRange(db, {
    attemptId,
    runToken,
    rangeIndex: 0,
    startPage: 1,
    endPage: totalPages,
    fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
    payload: rangePayload(nativeTextPages),
    now: NOW
  });
  await markConverted(db, attemptId, runToken, NOW);
}

describe("pdf import routes", () => {
  beforeEach(async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const db = createDbClient(pglite);
    const rootDir = await mkdtemp(join(tmpdir(), "pdf-import-routes-"));
    const stageStore = createPdfImportStageStore(rootDir);
    context = {
      db,
      rootDir,
      server: createServer({
        logger: false,
        pdfImport: { commands: commandDeps(db, stageStore), uploadLimitBytes: 10_000_000 }
      }),
      stageStore
    };
  });

  afterEach(async () => {
    await context.server.close();
    await rm(context.rootDir, { force: true, recursive: true });
  });

  it("queues a fresh attempt and returns its id and initial status", async () => {
    const response = await beginUpload(
      Buffer.from("%PDF-1.7 born-digital"),
      metadataHeader({ enteredTitle: "Chosen", fileName: "reading.pdf" })
    );

    expect(response.statusCode).toBe(201);
    const result = parsePdfImportBeginResultDto(response.json());
    if (result.outcome !== "queued") {
      throw new Error(`expected queued, got ${result.outcome}`);
    }
    expect(result.status.state).toBe("queued");
    expect(result.attemptId).toBe(result.status.attemptId);
  });

  it("reopens the owning Work when identical bytes were already published", async () => {
    const bytes = Buffer.from("%PDF-1.7 identical");
    const first = parsePdfImportBeginResultDto(
      (await beginUpload(bytes, metadataHeader({ fileName: "same.pdf" }))).json()
    );
    if (first.outcome !== "queued") {
      throw new Error("expected first upload to queue");
    }
    await driveToConverted(context.db, first.attemptId, [true]);
    await publishConvertedPdfImport(publishDeps(context.db), first.attemptId);

    const response = await beginUpload(bytes, metadataHeader({ fileName: "same-again.pdf" }));
    expect(response.statusCode).toBe(200);
    const reopened = parsePdfImportBeginResultDto(response.json());
    expect(reopened.outcome).toBe("reopened");
  });

  it("rejects a missing metadata header, invalid base64 JSON, and an empty body with 400", async () => {
    expect((await beginUpload(Buffer.from("%PDF"), undefined)).statusCode).toBe(400);
    expect(
      (await beginUpload(Buffer.from("%PDF"), Buffer.from("not-json").toString("base64"))).statusCode
    ).toBe(400);
    expect(
      (await beginUpload(Buffer.alloc(0), metadataHeader({ fileName: "empty.pdf" }))).statusCode
    ).toBe(400);
  });

  it("rejects metadata that fails validation with 400", async () => {
    const response = await beginUpload(
      Buffer.from("%PDF"),
      Buffer.from(JSON.stringify({ enteredTitle: "no file name" }), "utf8").toString("base64")
    );
    expect(response.statusCode).toBe(400);
  });

  it("serves the combined execution + publication view and 404s an unknown attempt", async () => {
    const queued = parsePdfImportBeginResultDto(
      (await beginUpload(Buffer.from("%PDF view"), metadataHeader({ fileName: "view.pdf" }))).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }

    const view = await context.server.inject({
      method: "GET",
      url: `/api/pdf-imports/${queued.attemptId}`
    });
    expect(view.statusCode).toBe(200);
    const parsed = parsePdfImportViewDto(view.json());
    expect(parsed.publication.status).toBe("pending");
    expect(parsed.status.attemptId).toBe(queued.attemptId);

    const missing = await context.server.inject({ method: "GET", url: "/api/pdf-imports/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("reports the published outcome in the view after the drain loop publishes", async () => {
    const queued = parsePdfImportBeginResultDto(
      (await beginUpload(Buffer.from("%PDF publish"), metadataHeader({ fileName: "done.pdf" }))).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await driveToConverted(context.db, queued.attemptId, [true]);
    await publishConvertedPdfImport(publishDeps(context.db), queued.attemptId);

    const view = parsePdfImportViewDto(
      (await context.server.inject({ method: "GET", url: `/api/pdf-imports/${queued.attemptId}` })).json()
    );
    if (view.publication.status !== "published") {
      throw new Error(`expected published, got ${view.publication.status}`);
    }
    expect(view.publication.workEntryId).toMatch(/^entry-/);
  });

  it("cancels an in-flight attempt and returns its updated view", async () => {
    const queued = parsePdfImportBeginResultDto(
      (await beginUpload(Buffer.from("%PDF cancel"), metadataHeader({ fileName: "cancel.pdf" }))).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }

    const response = await context.server.inject({
      method: "POST",
      url: `/api/pdf-imports/${queued.attemptId}/cancel`
    });
    expect(response.statusCode).toBe(200);
    const view = parsePdfImportViewDto(response.json());
    expect(view.status.state).toBe("cancelled");
  });

  it("404s a cancel for an unknown attempt", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/pdf-imports/nope/cancel"
    });
    expect(response.statusCode).toBe(404);
  });

  it("retries a failed attempt and returns its updated view", async () => {
    const queued = parsePdfImportBeginResultDto(
      (await beginUpload(Buffer.from("%PDF retry"), metadataHeader({ fileName: "retry.pdf" }))).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await context.server.inject({ method: "POST", url: `/api/pdf-imports/${queued.attemptId}/cancel` });

    const response = await context.server.inject({
      method: "POST",
      url: `/api/pdf-imports/${queued.attemptId}/retry`
    });
    expect(response.statusCode).toBe(200);
    const view = parsePdfImportViewDto(response.json());
    expect(view.status.attemptId).toBe(queued.attemptId);
  });

  it("404s a retry for an unknown attempt", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/pdf-imports/nope/retry"
    });
    expect(response.statusCode).toBe(404);
  });
});
