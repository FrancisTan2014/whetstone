import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parsePdfImportBeginResultDto,
  parsePdfImportViewDto,
  pdfContentType,
  RANGE_CONVERSION_SCHEMA_VERSION,
  type PdfImportStartMetadataDto,
  type RangeConversion,
  type StructuredDocItem,
  type WorkCreationReviewDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";
import { createSourceFileStore, type SourceFileStore } from "../../files/sourceFileStore.js";
import Fastify from "fastify";
import { registerPdfImportRoutes, type PdfImportBeginReviewResult } from "./pdfImportRoutes.js";
import {
  publishConvertedPdfImport,
  type PdfImportPublishDependencies
} from "./pdfImportPublish.js";
import type { PdfImportCommandDependencies } from "./pdfImportCommands.js";
import { createPdfImportActiveRuns } from "./pdfImportRunner.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
  markAwaitingReview,
  setProbeResult
} from "./pdfImportStore.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const doclingSchema = { name: "DoclingDocument", version: "1.10.0" } as const;

type TestContext = Readonly<{
  db: DbClient;
  rootDir: string;
  sourceFilesDir: string;
  server: ReturnType<typeof createServer>;
  stageStore: PdfImportStageStore;
  sourceFileStore: SourceFileStore;
  // The shared-review bridge the GET handler parks a converted attempt through (#750). Reassigned per test
  // so a poll of an `awaiting_review` attempt drives each route branch without wiring the real workCreation
  // command.
  beginReview: ReturnType<
    typeof vi.fn<(userId: string, attemptId: string) => Promise<PdfImportBeginReviewResult>>
  >;
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
    pages: nativeTextPages.map((hasNativeText, index) => ({
      hasNativeText,
      pageNumber: index + 1
    })),
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
    now: () => NOW,
    stageStore: context.stageStore,
    sourceFileStore: context.sourceFileStore,
    // These route tests never exercise a rendered-figure payload, so a no-op image store suffices.
    imageResourceStore: { store: async () => ({ id: "" }) },
    logCleanupFailure: vi.fn()
  };
}

// The upload-path tests below never poll an attempt, so the shared-review bridge is never reached; this
// stub fails loudly rather than silently standing in for a park none of them expects.
const unreachedBeginReview = (): Promise<PdfImportBeginReviewResult> =>
  Promise.reject(new Error("unexpected beginReview"));

function metadataHeader(
  metadata: Partial<PdfImportStartMetadataDto> & { fileName: string }
): string {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64");
}

function beginUpload(bytes: Buffer, header: string | undefined): Promise<LightMyRequestResponse> {
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

// Drive the attempt the server just queued through #721 to `awaiting_review` with one committed range, so
// the publication layer has a real parked attempt to reconstruct and open as a Work.
async function driveToAwaitingReview(
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
  await markAwaitingReview(db, attemptId, runToken, NOW);
}

describe("pdf import routes", () => {
  beforeEach(async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const db = createDbClient(pglite);
    const rootDir = await mkdtemp(join(tmpdir(), "pdf-import-routes-"));
    const sourceFilesDir = await mkdtemp(join(tmpdir(), "pdf-import-routes-src-"));
    const stageStore = createPdfImportStageStore(rootDir);
    const sourceFileStore = createSourceFileStore(sourceFilesDir);
    // Defaults to a no-op park (`not_awaiting`); a test that polls a converted attempt reassigns it.
    const beginReview = vi.fn<
      (userId: string, attemptId: string) => Promise<PdfImportBeginReviewResult>
    >(async () => ({ status: "not_awaiting" }));
    context = {
      db,
      rootDir,
      sourceFilesDir,
      beginReview,
      server: createServer({
        logger: false,
        pdfImport: {
          commands: commandDeps(db, stageStore),
          uploadLimitBytes: 10_000_000,
          beginReview: (userId, attemptId) => beginReview(userId, attemptId)
        }
      }),
      stageStore,
      sourceFileStore
    };
  });

  afterEach(async () => {
    await context.server.close();
    await rm(context.rootDir, { force: true, recursive: true });
    await rm(context.sourceFilesDir, { force: true, recursive: true });
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
    await driveToAwaitingReview(context.db, first.attemptId, [true]);
    await publishConvertedPdfImport(publishDeps(context.db), first.attemptId);

    const response = await beginUpload(bytes, metadataHeader({ fileName: "same-again.pdf" }));
    expect(response.statusCode).toBe(200);
    const reopened = parsePdfImportBeginResultDto(response.json());
    expect(reopened.outcome).toBe("reopened");
  });

  it("refuses a buffered request body with 400 (regression: the front door must never buffer the whole file)", async () => {
    // Wire the front door behind a BUFFERING parser (parseAs: "buffer") — exactly the misconfiguration
    // the reviewer flagged. The route's streamable-body guard must reject it rather than silently
    // materializing the whole PDF, so this returns 400 and the 128 MiB-buffering regression stays dead.
    const app = Fastify({ logger: false });
    app.addContentTypeParser(pdfContentType, { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body)
    );
    app.decorate("currentUser", { getCurrentUserId: () => "user-1" });
    registerPdfImportRoutes(app, {
      commands: commandDeps(context.db, context.stageStore),
      uploadLimitBytes: 10_000_000,
      beginReview: unreachedBeginReview
    });
    try {
      const response = await app.inject({
        headers: {
          "content-type": pdfContentType,
          "x-pdf-import-metadata": metadataHeader({ fileName: "buffered.pdf" })
        },
        method: "POST",
        payload: Buffer.from("%PDF buffered whole"),
        url: "/api/pdf-imports"
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });

      // With the same buffering parser, invalid metadata rejects even earlier: the pre-streaming drain is
      // a no-op on a non-stream (already-buffered) body, and the route still answers 400.
      const badMetadata = await app.inject({
        headers: {
          "content-type": pdfContentType,
          "x-pdf-import-metadata": Buffer.from("not-json").toString("base64")
        },
        method: "POST",
        payload: Buffer.from("%PDF buffered whole"),
        url: "/api/pdf-imports"
      });
      expect(badMetadata.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an empty streamed upload with 400 (nothing to import)", async () => {
    // A genuine request stream that yields no bytes: the parser hands a readable body (so the streamable
    // guard passes), beginPdfImport stages zero bytes and reports the upload empty, which the route maps
    // to 400.
    const response = await context.server.inject({
      headers: {
        "content-type": pdfContentType,
        "x-pdf-import-metadata": metadataHeader({ fileName: "empty-stream.pdf" })
      },
      method: "POST",
      payload: Readable.from([]),
      url: "/api/pdf-imports"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("surfaces an unexpected staging error as a 500 (rethrown, not swallowed as too-large)", async () => {
    // A staging failure that is NOT PdfUploadTooLargeError must propagate (becoming a 500), never be
    // mistaken for a 413 — the catch rethrows anything that is not the byte-bound error.
    const failingStage: PdfImportStageStore = {
      ...context.stageStore,
      createStageFromStream: () => Promise.reject(new Error("disk exploded"))
    };
    const server = createServer({
      logger: false,
      pdfImport: {
        commands: commandDeps(context.db, failingStage),
        uploadLimitBytes: 10_000_000,
        beginReview: unreachedBeginReview
      }
    });
    try {
      const response = await server.inject({
        headers: {
          "content-type": pdfContentType,
          "x-pdf-import-metadata": metadataHeader({ fileName: "boom.pdf" })
        },
        method: "POST",
        payload: Readable.from([Buffer.from("%PDF")]),
        url: "/api/pdf-imports"
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await server.close();
    }
  });

  it("streams a chunked upload body straight into the stage, assembling it without buffering the whole file", async () => {
    const chunks = [
      Buffer.from("%PDF-1.7 "),
      Buffer.from("chunk-two "),
      Buffer.from("chunk-three")
    ];
    const whole = Buffer.concat(chunks);
    const response = await context.server.inject({
      headers: {
        "content-type": pdfContentType,
        "x-pdf-import-metadata": metadataHeader({ fileName: "streamed.pdf" })
      },
      method: "POST",
      // A genuine multi-chunk request stream: the front door must consume it as a stream. If the shared
      // parser is reverted to buffering the whole body, `isReadableBody` fails and this returns 400.
      payload: Readable.from(chunks),
      url: "/api/pdf-imports"
    });

    expect(response.statusCode).toBe(201);
    const result = parsePdfImportBeginResultDto(response.json());
    if (result.outcome !== "queued") {
      throw new Error(`expected queued, got ${result.outcome}`);
    }
    // The streamed chunks were assembled on disk exactly as sent (hashed incrementally, never buffered).
    const staged = await context.stageStore.readStage(result.attemptId);
    expect(Buffer.from(staged)).toEqual(whole);
  });

  it("rejects an upload that exceeds the configured byte limit with 413", async () => {
    const smallServer = createServer({
      logger: false,
      pdfImport: {
        commands: commandDeps(context.db, context.stageStore),
        uploadLimitBytes: 4,
        beginReview: unreachedBeginReview
      }
    });
    try {
      const response = await smallServer.inject({
        headers: {
          "content-type": pdfContentType,
          "x-pdf-import-metadata": metadataHeader({ fileName: "big.pdf" })
        },
        method: "POST",
        payload: Buffer.from("%PDF far past the four-byte bound"),
        url: "/api/pdf-imports"
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: "upload_too_large" });
    } finally {
      await smallServer.close();
    }
  });

  it("rejects a missing metadata header, invalid base64 JSON, and an empty body with 400", async () => {
    expect((await beginUpload(Buffer.from("%PDF"), undefined)).statusCode).toBe(400);
    expect(
      (await beginUpload(Buffer.from("%PDF"), Buffer.from("not-json").toString("base64")))
        .statusCode
    ).toBe(400);
    expect(
      (await beginUpload(Buffer.alloc(0), metadataHeader({ fileName: "empty.pdf" }))).statusCode
    ).toBe(400);
  });

  it("drains a streamed request body before rejecting on invalid metadata", async () => {
    // Invalid metadata rejects early, but a genuine multi-chunk body must still be drained (consumed and
    // discarded) so the connection is not left with a dangling stream.
    const response = await context.server.inject({
      headers: {
        "content-type": pdfContentType,
        "x-pdf-import-metadata": Buffer.from("not-json").toString("base64")
      },
      method: "POST",
      payload: Readable.from([Buffer.from("%PDF-1.7 "), Buffer.from("more body bytes")]),
      url: "/api/pdf-imports"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a missing metadata header even when the request carries no body at all", async () => {
    // No payload means no request body to drain: the metadata check still 400s and drainBody is a no-op.
    const response = await context.server.inject({
      headers: { "content-type": pdfContentType },
      method: "POST",
      url: "/api/pdf-imports"
    });
    expect(response.statusCode).toBe(400);
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

  it("reports the published outcome in the view after a review decision publishes", async () => {
    const queued = parsePdfImportBeginResultDto(
      (
        await beginUpload(Buffer.from("%PDF publish"), metadataHeader({ fileName: "done.pdf" }))
      ).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await driveToAwaitingReview(context.db, queued.attemptId, [true]);
    await publishConvertedPdfImport(publishDeps(context.db), queued.attemptId);

    const view = parsePdfImportViewDto(
      (
        await context.server.inject({ method: "GET", url: `/api/pdf-imports/${queued.attemptId}` })
      ).json()
    );
    if (view.publication.status !== "published") {
      throw new Error(`expected published, got ${view.publication.status}`);
    }
    expect(view.publication.workEntryId).toMatch(/^entry-/);
  });

  it("parks a converted attempt at the shared review boundary on the first poll and attaches the panel", async () => {
    const queued = parsePdfImportBeginResultDto(
      (
        await beginUpload(Buffer.from("%PDF review"), metadataHeader({ fileName: "review.pdf" }))
      ).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await driveToAwaitingReview(context.db, queued.attemptId, [true]);

    // A credible duplicate parked one review attempt: the poll must surface the panel the client renders.
    const reviewStub: WorkCreationReviewDto = {
      attemptId: queued.attemptId,
      revision: 0,
      proposed: { title: "The Work", authorName: "Unknown", language: "en", workType: "book" },
      candidates: [],
      candidateFingerprint: "",
      sourceFileName: "review.pdf"
    };
    context.beginReview.mockResolvedValue({
      status: "needs_review",
      review: reviewStub
    });

    const response = await context.server.inject({
      method: "GET",
      url: `/api/pdf-imports/${queued.attemptId}`
    });

    expect(response.statusCode).toBe(200);
    expect(context.beginReview).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      queued.attemptId
    );
    const body = response.json() as { review?: unknown; status: { attemptId: string } };
    expect(body.review).toEqual(reviewStub);
    expect(body.status.attemptId).toBe(queued.attemptId);
  });

  it("parks silently and attaches no panel when the review resolves without a duplicate", async () => {
    const queued = parsePdfImportBeginResultDto(
      (
        await beginUpload(Buffer.from("%PDF created"), metadataHeader({ fileName: "created.pdf" }))
      ).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await driveToAwaitingReview(context.db, queued.attemptId, [true]);
    // No credible duplicate: the review published immediately, so the poll returns the view with no panel.
    context.beginReview.mockResolvedValue({ status: "created" });

    const response = await context.server.inject({
      method: "GET",
      url: `/api/pdf-imports/${queued.attemptId}`
    });

    expect(response.statusCode).toBe(200);
    expect(context.beginReview).toHaveBeenCalledOnce();
    const body = response.json() as { review?: unknown };
    expect(body.review).toBeNull();
    // The re-read view still parses as a plain view DTO (review is null, no panel appended).
    expect(() => parsePdfImportViewDto(body)).not.toThrow();
  });

  it("404s when the attempt disappears between parking and the re-read", async () => {
    const queued = parsePdfImportBeginResultDto(
      (await beginUpload(Buffer.from("%PDF gone"), metadataHeader({ fileName: "gone.pdf" }))).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await driveToAwaitingReview(context.db, queued.attemptId, [true]);
    // Model the row vanishing under the re-read (a torn-down attempt): the handler must answer 404, not 500.
    context.beginReview.mockImplementation(async (_userId, attemptId) => {
      await context.db.execute(sql`DELETE FROM pdf_import_attempts WHERE id = ${attemptId}`);
      return { status: "not_awaiting" };
    });

    const response = await context.server.inject({
      method: "GET",
      url: `/api/pdf-imports/${queued.attemptId}`
    });

    expect(response.statusCode).toBe(404);
  });

  it("cancels an in-flight attempt and returns its updated view", async () => {
    const queued = parsePdfImportBeginResultDto(
      (
        await beginUpload(Buffer.from("%PDF cancel"), metadataHeader({ fileName: "cancel.pdf" }))
      ).json()
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
      (
        await beginUpload(Buffer.from("%PDF retry"), metadataHeader({ fileName: "retry.pdf" }))
      ).json()
    );
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    await context.server.inject({
      method: "POST",
      url: `/api/pdf-imports/${queued.attemptId}/cancel`
    });

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
