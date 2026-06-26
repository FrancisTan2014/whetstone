import { epubContentType, ingestMarkdownRequestSchema } from "@whetstone/contracts";
import { blocksToMarkdown, toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { ingestMarkdown, type ContentDependencies } from "./contentCommands.js";
import { ingestEpub } from "./epubCommands.js";
import {
  loadReadingUnitContent,
  loadWorkContent,
  loadWorkStructure,
  locateBlockUnit,
  workExists
} from "./contentQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const invalidEpubBody = { error: "invalid_epub" } as const;
const workNotFoundBody = { error: "work_not_found" } as const;
const unitNotFoundBody = { error: "unit_not_found" } as const;
const blockNotFoundBody = { error: "block_not_found" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;
type UnitParams = Readonly<{ unitEntryId: string; workEntryId: string }>;
type BlockParams = Readonly<{ blockEntryId: string; workEntryId: string }>;

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

  // The lightweight outline a lazy-loading reader fetches first: units + block counts, no content.
  server.get<{ Params: WorkParams }>(
    "/api/works/:workEntryId/structure",
    async (request, reply) => {
      const workEntryId = toEntryId(request.params.workEntryId);

      if (!(await workExists(dependencies.db, workEntryId))) {
        return reply.code(404).send(workNotFoundBody);
      }

      return loadWorkStructure(dependencies.db, workEntryId);
    }
  );

  // One unit's blocks on demand. 404 covers both an unknown unit and one in another work.
  server.get<{ Params: UnitParams }>(
    "/api/works/:workEntryId/units/:unitEntryId/content",
    async (request, reply) => {
      const workEntryId = toEntryId(request.params.workEntryId);
      const unitEntryId = toEntryId(request.params.unitEntryId);
      const content = await loadReadingUnitContent(dependencies.db, workEntryId, unitEntryId);

      if (content === undefined) {
        return reply.code(404).send(unitNotFoundBody);
      }

      return content;
    }
  );

  // Resolve a block to its owning unit for deep-links / jump-to-note. 404 covers an unknown,
  // soft-deleted, or other-work block.
  server.get<{ Params: BlockParams }>(
    "/api/works/:workEntryId/blocks/:blockEntryId/unit",
    async (request, reply) => {
      const workEntryId = toEntryId(request.params.workEntryId);
      const blockEntryId = toEntryId(request.params.blockEntryId);
      const unitEntryId = await locateBlockUnit(dependencies.db, workEntryId, blockEntryId);

      if (unitEntryId === undefined) {
        return reply.code(404).send(blockNotFoundBody);
      }

      return { unitEntryId };
    }
  );

  server.get<{ Params: WorkParams }>(
    "/api/works/:workEntryId/content/markdown",
    async (request, reply) => {
      const workEntryId = toEntryId(request.params.workEntryId);

      if (!(await workExists(dependencies.db, workEntryId))) {
        return reply.code(404).send(workNotFoundBody);
      }

      const content = await loadWorkContent(dependencies.db, workEntryId);
      const markdown = blocksToMarkdown(
        content.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.mdast))
      );

      return reply.type("text/markdown; charset=utf-8").send(markdown);
    }
  );
}
