import { createAuthorRequestSchema, createWorkRequestSchema } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { createAuthor, createWork, type LibraryDependencies } from "./libraryCommands.js";
import { listAuthors, listWorks } from "./libraryQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

export function registerLibraryRoutes(
  server: FastifyInstance,
  dependencies: LibraryDependencies
): void {
  server.post("/api/authors", async (request, reply) => {
    const parsed = createAuthorRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const author = await createAuthor(dependencies, parsed.data);
    request.log.info({ authorId: author.id, route: "POST /api/authors" }, "author_created");

    return reply.code(201).send(author);
  });

  server.get("/api/authors", async () => listAuthors(dependencies.db));

  server.post("/api/works", async (request, reply) => {
    const parsed = createWorkRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const result = await createWork(dependencies, parsed.data);

    if (result.status === "author_not_found") {
      return reply.code(400).send({ error: "author_not_found", authorId: result.authorId });
    }

    request.log.info(
      {
        entryId: result.work.work.entryId,
        route: "POST /api/works",
        workType: result.work.work.workType
      },
      "work_created"
    );

    return reply.code(201).send(result.work);
  });

  server.get("/api/works", async () => listWorks(dependencies.db));
}
