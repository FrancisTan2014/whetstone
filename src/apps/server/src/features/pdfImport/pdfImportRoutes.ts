import {
  pdfContentType,
  pdfImportStartMetadataSchema,
  type PdfImportBeginResultDto,
  type PdfImportViewDto
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import {
  cancelPdfImport,
  retryPdfImport,
  type PdfImportCommandDependencies
} from "./pdfImportCommands.js";
import { beginPdfImport } from "./pdfImportPublish.js";
import { getPdfImportView } from "./pdfImportQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const attemptNotFoundBody = { error: "attempt_not_found" } as const;

// The client sends the upload-time metadata (picked file name + optional entered title/author/language)
// in this header as base64-encoded JSON, so the request body stays the raw PDF bytes (parsed by the
// shared pdf buffer content-type parser) and the metadata survives non-ASCII values a raw header cannot
// carry.
const metadataHeader = "x-pdf-import-metadata";

export type PdfImportRouteDependencies = Readonly<{
  commands: PdfImportCommandDependencies;
  uploadLimitBytes: number;
}>;

type AttemptParams = Readonly<{ attemptId: string }>;

// The born-digital PDF import routes (#702): start an import (streaming into #721's staged attempt, or
// reopening the Work identical bytes already own via #706), poll its combined execution + publication
// view, and cancel or retry it. Publication of a converted attempt is driven by the server's drain loop,
// not these routes — the client observes it through the view's publication outcome.
export function registerPdfImportRoutes(
  server: FastifyInstance,
  dependencies: PdfImportRouteDependencies
): void {
  // The pdf buffer parser may already be registered by the content routes; register it at most once.
  if (!server.hasContentTypeParser(pdfContentType)) {
    server.addContentTypeParser(pdfContentType, { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body)
    );
  }

  server.post(
    "/api/pdf-imports",
    { bodyLimit: dependencies.uploadLimitBytes },
    async (request, reply) => {
      const rawMetadata = request.headers[metadataHeader];
      if (typeof rawMetadata !== "string") {
        return reply.code(400).send(invalidRequestBody);
      }

      let decodedMetadata: unknown;
      try {
        decodedMetadata = JSON.parse(Buffer.from(rawMetadata, "base64").toString("utf8"));
      } catch {
        return reply.code(400).send(invalidRequestBody);
      }

      const metadata = pdfImportStartMetadataSchema.safeParse(decodedMetadata);
      const body = request.body;
      if (!metadata.success || !Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send(invalidRequestBody);
      }

      const result = await beginPdfImport(
        { db: dependencies.commands.db, start: dependencies.commands },
        {
          bytes: new Uint8Array(body),
          enteredAuthor: metadata.data.enteredAuthor,
          enteredLanguage: metadata.data.enteredLanguage,
          enteredTitle: metadata.data.enteredTitle,
          fileName: metadata.data.fileName,
          userId: request.server.currentUser.getCurrentUserId()
        }
      );

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
    }
  );

  server.get<{ Params: AttemptParams }>("/api/pdf-imports/:attemptId", async (request, reply) => {
    const view = await viewFor(
      dependencies,
      request.server.currentUser.getCurrentUserId(),
      request.params.attemptId
    );
    if (view === null) {
      return reply.code(404).send(attemptNotFoundBody);
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
