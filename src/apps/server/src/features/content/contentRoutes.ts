import { epubContentType, ingestMarkdownRequestSchema } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { ingestMarkdown, type ContentDependencies } from "./contentCommands.js";
import { ingestEpub } from "./epubCommands.js";
import { loadWorkContent, workExists } from "./contentQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const invalidEpubBody = { error: "invalid_epub" } as const;
const workNotFoundBody = { error: "work_not_found" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;

export function registerContentRoutes(
  server: FastifyInstance,
  dependencies: ContentDependencies
): void {
  server.addContentTypeParser(epubContentType, { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body)
  );

  server.post(
    "/api/works/epub",
    { bodyLimit: dependencies.epubUploadLimitBytes },
    async (request, reply) => {
      const body = request.body;

      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send(invalidRequestBody);
      }

      const result = await ingestEpub(dependencies, new Uint8Array(body));

      if (result.status === "invalid_epub") {
        return reply.code(422).send(invalidEpubBody);
      }

      request.log.info(
        {
          readingUnitCount: result.result.content.readingUnits.length,
          route: "POST /api/works/epub",
          status: result.status,
          workEntryId: result.result.work.entryId
        },
        "work_epub_ingested"
      );

      return reply.code(result.status === "duplicate" ? 200 : 201).send(result.result);
    }
  );

  server.post<{ Params: WorkParams }>("/api/works/:workEntryId/content", async (request, reply) => {
    const parsed = ingestMarkdownRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const workEntryId = toEntryId(request.params.workEntryId);
    const result = await ingestMarkdown(dependencies, workEntryId, parsed.data);

    if (result.status === "work_not_found") {
      return reply.code(404).send(workNotFoundBody);
    }

    request.log.info(
      {
        readingUnitCount: result.content.readingUnits.length,
        route: "POST /api/works/:workEntryId/content",
        workEntryId
      },
      "work_content_ingested"
    );

    return reply.code(201).send(result.content);
  });

  server.get<{ Params: WorkParams }>("/api/works/:workEntryId/content", async (request, reply) => {
    const workEntryId = toEntryId(request.params.workEntryId);

    if (!(await workExists(dependencies.db, workEntryId))) {
      return reply.code(404).send(workNotFoundBody);
    }

    return loadWorkContent(dependencies.db, workEntryId);
  });
}
