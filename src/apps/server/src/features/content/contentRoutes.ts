import { ingestMarkdownRequestSchema } from "@whetstone/contracts";
import { blocksToMarkdown, toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { ingestMarkdown, type ContentDependencies } from "./contentCommands.js";
import { loadWorkContent, workExists } from "./contentQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const workNotFoundBody = { error: "work_not_found" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;

export function registerContentRoutes(
  server: FastifyInstance,
  dependencies: ContentDependencies
): void {
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
