import {
  createAuthoredWorkRequestSchema,
  updateAuthoredWorkContentRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  createAuthoredWork,
  updateAuthoredWorkContent,
  type AuthoredWorkDependencies
} from "./authoredWorkCommands.js";
import {
  getLatestAuthoredWorkInProgress,
  listAuthoredWorks,
  loadAuthoredWorkForEditing
} from "./authoredWorkQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

type WorkParams = Readonly<{ id: string }>;

export type AuthoredWorkRouteDependencies = AuthoredWorkDependencies;

export function registerAuthoredWorkRoutes(
  server: FastifyInstance,
  dependencies: AuthoredWorkRouteDependencies
): void {
  // Create an owned Work with an empty document and return it, ready for the editor to open (#576).
  server.post("/api/authored-works", async (request, reply) => {
    const parsed = createAuthoredWorkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const work = await createAuthoredWork(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );
    request.log.info(
      { route: "POST /api/authored-works", workEntryId: work.entryId },
      "authored_work_created"
    );

    return reply.code(201).send(work);
  });

  // List the user's authored Works (summaries, newest edit first) so the Library can badge owned drafts
  // and route them to the editor.
  server.get("/api/authored-works", async (request) => {
    const works = await listAuthoredWorks(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );
    return { works };
  });

  // Today's "Continue writing" target: the most recently edited authored Work, or null when there is none.
  // Registered before the `:id` route so the static path wins over the parametric one.
  server.get("/api/authored-works/continue", async (request) => {
    const work = await getLatestAuthoredWorkInProgress(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );
    return { work };
  });

  // Load one authored Work with its reassembled document, for editing or reading. Owner-scoped: an unknown
  // id, another user's Work, or an imported Work is 404.
  server.get<{ Params: WorkParams }>("/api/authored-works/:id", async (request, reply) => {
    const work = await loadAuthoredWorkForEditing(
      dependencies.db,
      toEntryId(request.params.id),
      request.server.currentUser.getCurrentUserId()
    );
    if (work === undefined) {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send(work);
  });

  // Save an authored Work's document (autosave / explicit save): latest-write-safe, id-preserving replace.
  // Owner-scoped (404 otherwise); a malformed/unsafe document is rejected at the boundary (400).
  server.put<{ Params: WorkParams }>("/api/authored-works/:id/content", async (request, reply) => {
    const parsed = updateAuthoredWorkContentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await updateAuthoredWorkContent(
      dependencies,
      toEntryId(request.params.id),
      parsed.data.document,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }

    request.log.info(
      { route: "PUT /api/authored-works/:id/content", workEntryId: result.work.entryId },
      "authored_work_saved"
    );

    return reply.code(200).send(result.work);
  });
}
