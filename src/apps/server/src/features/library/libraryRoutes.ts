import {
  addManualWorkSectionRequestSchema,
  createAuthorRequestSchema,
  createWorkRequestSchema,
  updateManualWorkContentRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  createAuthor,
  createWork,
  deleteWork,
  type DeleteWorkDependencies,
  type LibraryDependencies
} from "./libraryCommands.js";
import { addManualWorkSection, updateManualWorkContent } from "./manualWorkContentCommands.js";
import { loadManualWorkForEditing, loadManualWorkUnit } from "./manualWorkContentQueries.js";
import { listWorks, searchAuthors } from "./libraryQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;
// A manual Work create was attempted through the legacy metadata route, which no longer commits one:
// manual creation is owned by the `POST /api/works/manual` duplicate-review front door (#749).
const manualRequiresReview = { error: "manual_requires_review" } as const;

// The library routes need the create dependencies plus the delete-work capability (DB cascade + a
// best-effort source-file unlink), composed at wiring time.
export type LibraryRouteDependencies = LibraryDependencies & DeleteWorkDependencies;

type WorkParams = Readonly<{ workEntryId: string }>;

type WorkUnitParams = Readonly<{ unitEntryId: string; workEntryId: string }>;

// The author search field passes its raw query through; the server owns cleaning and matching.
type AuthorSearchQuery = Readonly<{ query?: string }>;

export function registerLibraryRoutes(
  server: FastifyInstance,
  dependencies: LibraryRouteDependencies
): void {
  server.post("/api/authors", async (request, reply) => {
    const parsed = createAuthorRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const { author, created } = await createAuthor(dependencies, parsed.data);
    request.log.info(
      { authorId: author.id, created, route: "POST /api/authors" },
      created ? "author_created" : "author_resolved"
    );

    return reply.code(created ? 201 : 200).send(author);
  });

  server.get<{ Querystring: AuthorSearchQuery }>("/api/authors", async (request) =>
    searchAuthors(dependencies.db, request.query.query)
  );

  server.post("/api/works", async (request, reply) => {
    const parsed = createWorkRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    // Manual Works must be created through the duplicate-review front door (`POST /api/works/manual`,
    // #749), which reviews #724 candidates before any commit. This legacy metadata route only mints
    // imported upload shells; accepting `origin: "manual"` here would let a client commit an unreviewed
    // manual Work — and create/resolve its author as a side effect — around that boundary, so it is
    // refused before any write.
    if (parsed.data.origin === "manual") {
      return reply.code(400).send(manualRequiresReview);
    }

    const result = await createWork(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );

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

  // Load one manual Work opened at its first section, with that section's reassembled canonical document
  // and the ordered section list the Outline is derived from, for the Library editor to open (#697).
  // Owner-scoped and origin-scoped: an unknown id, another user's Work, an imported Work, or an authored
  // Work is 404.
  server.get<{ Params: WorkParams }>("/api/manual-works/:workEntryId", async (request, reply) => {
    const work = await loadManualWorkForEditing(
      dependencies.db,
      toEntryId(request.params.workEntryId),
      request.server.currentUser.getCurrentUserId()
    );

    if (work === undefined) {
      return reply.code(404).send(notFound);
    }

    return reply.code(200).send(work);
  });

  // Load one section's reassembled canonical document, for the editor to open a section the learner
  // navigated to in the Outline (#697). Owner/origin-scoped like the parent Work, and the section must
  // belong to that Work — otherwise 404.
  server.get<{ Params: WorkUnitParams }>(
    "/api/manual-works/:workEntryId/units/:unitEntryId",
    async (request, reply) => {
      const unit = await loadManualWorkUnit(
        dependencies.db,
        toEntryId(request.params.workEntryId),
        toEntryId(request.params.unitEntryId),
        request.server.currentUser.getCurrentUserId()
      );

      if (unit === undefined) {
        return reply.code(404).send(notFound);
      }

      return reply.code(200).send(unit);
    }
  );

  // Append a new section (a new reading unit seeded with a heading block) to a manual Work and return it
  // opened at that section (#697). Owner/origin-scoped (404 otherwise); a stale revision is a 409 that
  // writes nothing, so the editor keeps its state and can reload.
  server.post<{ Params: WorkParams }>(
    "/api/manual-works/:workEntryId/units",
    async (request, reply) => {
      const parsed = addManualWorkSectionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const result = await addManualWorkSection(
        dependencies,
        toEntryId(request.params.workEntryId),
        parsed.data.revision,
        request.server.currentUser.getCurrentUserId()
      );

      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      if (result.status === "conflict") {
        return reply.code(409).send({ error: "revision_conflict" });
      }

      request.log.info(
        {
          route: "POST /api/manual-works/:workEntryId/units",
          unitEntryId: result.work.unitEntryId,
          workEntryId: result.work.entryId
        },
        "manual_work_section_added"
      );

      return reply.code(201).send(result.work);
    }
  );

  // Save one section's canonical document with work-level revision protection (#697): id-preserving
  // replace scoped to the owner and `origin = 'manual'` (404 otherwise), and the section must belong to
  // the Work (404). A malformed/unsafe document is rejected at the boundary (400); a stale revision —
  // another session saved in between — is a 409 and writes nothing, so the editor keeps its local
  // document and can reload.
  server.put<{ Params: WorkUnitParams }>(
    "/api/manual-works/:workEntryId/units/:unitEntryId/content",
    async (request, reply) => {
      const parsed = updateManualWorkContentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const result = await updateManualWorkContent(
        dependencies,
        toEntryId(request.params.workEntryId),
        toEntryId(request.params.unitEntryId),
        parsed.data.document,
        parsed.data.revision,
        request.server.currentUser.getCurrentUserId()
      );

      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      if (result.status === "conflict") {
        return reply.code(409).send({ error: "revision_conflict" });
      }

      request.log.info(
        {
          route: "PUT /api/manual-works/:workEntryId/units/:unitEntryId/content",
          unitEntryId: result.work.unitEntryId,
          workEntryId: result.work.entryId
        },
        "manual_work_saved"
      );

      return reply.code(200).send(result.work);
    }
  );
}
