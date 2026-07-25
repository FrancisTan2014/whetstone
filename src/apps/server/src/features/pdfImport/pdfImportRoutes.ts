import {
  pdfImportStartMetadataSchema,
  type PdfImportBeginResultDto,
  type PdfImportViewDto,
  type WorkCreationReviewDto
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import {
  cancelPdfImport,
  retryPdfImport,
  type PdfImportCommandDependencies
} from "./pdfImportCommands.js";
import { beginPdfImport } from "./pdfImportPublish.js";
import { getPdfImportView } from "./pdfImportQueries.js";
import { PdfUploadTooLargeError } from "./pdfImportStage.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const uploadTooLargeBody = { error: "upload_too_large" } as const;
const attemptNotFoundBody = { error: "attempt_not_found" } as const;

// The client sends the upload-time metadata (picked file name + optional entered title/author/language)
// in this header as base64-encoded JSON, so the request body stays the raw PDF stream (handed through by
// the server's pdf passthrough parser, never buffered) and the metadata survives non-ASCII values a raw
// header cannot carry.
const metadataHeader = "x-pdf-import-metadata";

// The result of parking a converted attempt at the shared Work-creation review boundary (#750), typed
// structurally through the shared contract DTO so this route never imports workCreation internals. Only
// `needs_review` carries a panel the client renders; every other status is resolved through the view's
// publication field, so the route just attaches a null review.
export type PdfImportBeginReviewResult =
  | Readonly<{ status: "needs_review"; review: WorkCreationReviewDto }>
  | Readonly<{ status: "created" | "exact_existing" | "refused" | "not_awaiting" | "uncertain" }>;

export type PdfImportRouteDependencies = Readonly<{
  commands: PdfImportCommandDependencies;
  uploadLimitBytes: number;
  // Park a converted attempt at the shared duplicate-review boundary on the first status read after
  // conversion; idempotent and a no-op unless the attempt is awaiting review.
  beginReview: (userId: string, attemptId: string) => Promise<PdfImportBeginReviewResult>;
}>;

type AttemptParams = Readonly<{ attemptId: string }>;

// The request body is the raw PDF stream (an async iterable of byte chunks). A non-streaming body means
// the shared pdf content-type parser was misconfigured to buffer — which this front door must never do —
// so the route treats it as invalid rather than silently materializing the whole file.
function isReadableBody(body: unknown): body is AsyncIterable<Uint8Array> {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function"
  );
}

// Drain an unconsumed request stream before answering an early (pre-streaming) validation error, so the
// connection is not left with a dangling body. A missing/non-stream body (no payload) is a no-op.
async function drainBody(body: unknown): Promise<void> {
  if (!isReadableBody(body)) {
    return;
  }
  // Consume and discard the unread upload so the connection is not left with a dangling body.
  for await (const chunk of body) {
    void chunk;
  }
}

// The born-digital PDF import routes (#702): start an import (streaming the upload into #721's staged
// attempt, or reopening the Work identical bytes already own via #706), poll its combined execution +
// publication + review view, and cancel or retry it. Publication of a converted attempt is driven ONLY by
// a serialized Work-creation review decision (#750): the first poll after conversion parks the attempt at
// the shared duplicate-review boundary, and the client observes the outcome through the view's publication
// field or renders the returned review panel. The upload's content-type parser is a streaming passthrough
// registered once by `createServer`, so the raw request stream flows straight into the staging/hash
// boundary and is never buffered whole in memory.
export function registerPdfImportRoutes(
  server: FastifyInstance,
  dependencies: PdfImportRouteDependencies
): void {
  server.post("/api/pdf-imports", async (request, reply) => {
    const rawMetadata = request.headers[metadataHeader];
    if (typeof rawMetadata !== "string") {
      await drainBody(request.body);
      return reply.code(400).send(invalidRequestBody);
    }

    let decodedMetadata: unknown;
    try {
      decodedMetadata = JSON.parse(Buffer.from(rawMetadata, "base64").toString("utf8"));
    } catch {
      await drainBody(request.body);
      return reply.code(400).send(invalidRequestBody);
    }

    const metadata = pdfImportStartMetadataSchema.safeParse(decodedMetadata);
    if (!metadata.success) {
      await drainBody(request.body);
      return reply.code(400).send(invalidRequestBody);
    }

    if (!isReadableBody(request.body)) {
      return reply.code(400).send(invalidRequestBody);
    }

    let result;
    try {
      result = await beginPdfImport(
        { db: dependencies.commands.db, start: dependencies.commands },
        {
          source: request.body,
          maxBytes: dependencies.uploadLimitBytes,
          enteredAuthor: metadata.data.enteredAuthor,
          enteredLanguage: metadata.data.enteredLanguage,
          enteredTitle: metadata.data.enteredTitle,
          fileName: metadata.data.fileName,
          ocrLanguageOverride: metadata.data.ocrLanguageOverride,
          userId: request.server.currentUser.getCurrentUserId()
        }
      );
    } catch (cause) {
      if (cause instanceof PdfUploadTooLargeError) {
        return reply.code(413).send(uploadTooLargeBody);
      }
      throw cause;
    }

    if (result.outcome === "empty") {
      return reply.code(400).send(invalidRequestBody);
    }

    if (result.outcome === "reopened") {
      const response: PdfImportBeginResultDto = {
        outcome: "reopened",
        workEntryId: result.work.entryId
      };
      return reply.code(200).send(response);
    }

    const response: PdfImportBeginResultDto = {
      attemptId: result.started.attemptId,
      outcome: "queued",
      status: result.started.status
    };
    return reply.code(201).send(response);
  });

  server.get<{ Params: AttemptParams }>("/api/pdf-imports/:attemptId", async (request, reply) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const attemptId = request.params.attemptId;
    const view = await viewFor(dependencies, userId, attemptId);
    if (view === null) {
      return reply.code(404).send(attemptNotFoundBody);
    }
    // A converted attempt is parked at the shared duplicate-review boundary on the first read after
    // conversion (#750); parking is idempotent. Re-read the view afterwards so an immediate create/reopen
    // or refusal is reflected in its publication field, and surface the panel only when a duplicate parked
    // one review attempt.
    if (view.status.state === "awaiting_review") {
      const result = await dependencies.beginReview(userId, attemptId);
      const parked = await viewFor(dependencies, userId, attemptId);
      if (parked === null) {
        return reply.code(404).send(attemptNotFoundBody);
      }
      return reply
        .code(200)
        .send(result.status === "needs_review" ? { ...parked, review: result.review } : parked);
    }
    return reply.code(200).send(view);
  });

  server.post<{ Params: AttemptParams }>(
    "/api/pdf-imports/:attemptId/cancel",
    async (request, reply) => {
      const userId = request.server.currentUser.getCurrentUserId();
      await cancelPdfImport(dependencies.commands, { attemptId: request.params.attemptId, userId });
      const view = await viewFor(dependencies, userId, request.params.attemptId);
      if (view === null) {
        return reply.code(404).send(attemptNotFoundBody);
      }
      return reply.code(200).send(view);
    }
  );

  server.post<{ Params: AttemptParams }>(
    "/api/pdf-imports/:attemptId/retry",
    async (request, reply) => {
      const userId = request.server.currentUser.getCurrentUserId();
      await retryPdfImport(dependencies.commands, { attemptId: request.params.attemptId, userId });
      const view = await viewFor(dependencies, userId, request.params.attemptId);
      if (view === null) {
        return reply.code(404).send(attemptNotFoundBody);
      }
      return reply.code(200).send(view);
    }
  );
}

async function viewFor(
  dependencies: PdfImportRouteDependencies,
  userId: string,
  attemptId: string
): Promise<PdfImportViewDto | null> {
  return getPdfImportView(dependencies.commands.db, userId, attemptId);
}
