import { createAuthorRequestSchema, createWorkRequestSchema } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  createAuthor,
  createWork,
  deleteWork,
  type DeleteWorkDependencies,
  type LibraryDependencies
} from "./libraryCommands.js";
import { listAuthors, listWorks } from "./libraryQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

// The library routes need the create dependencies plus the delete-work capability (DB cascade + a
// best-effort source-file unlink), composed at wiring time.
export type LibraryRouteDependencies = LibraryDependencies & DeleteWorkDependencies;

type WorkParams = Readonly<{ workEntryId: string }>;

export function registerLibraryRoutes(
  server: FastifyInstance,
  dependencies: LibraryRouteDependencies
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

  // Permanently delete a work and cascade its owned content (#541). Works are shared content with no
  // per-user owner, so an unknown work id is a 404; success is a bodyless 204.
  server.delete<{ Params: WorkParams }>("/api/works/:workEntryId", async (request, reply) => {
    const workEntryId = toEntryId(request.params.workEntryId);
    const result = await deleteWork(dependencies, workEntryId);

    if (result === "not_found") {
      return reply.code(404).send({ error: "work_not_found" });
    }

    request.log.info({ route: "DELETE /api/works/:workEntryId", workEntryId }, "work_deleted");

    return reply.code(204).send();
  });
}
