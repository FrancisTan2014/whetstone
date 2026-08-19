import {
  addImportedWorkSectionRequestSchema,
  addManualWorkSectionRequestSchema,
  correctImportedWorkContentRequestSchema,
  createAuthorRequestSchema,
  updateManualWorkContentRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  createAuthor,
  deleteWork,
  type DeleteWorkDependencies,
  type LibraryDependencies
} from "./libraryCommands.js";
import {
  addImportedWorkSection,
  correctImportedWorkContent
} from "./importedWorkContentCommands.js";
import {
  loadImportedWorkForCorrection,
  loadImportedWorkUnit
} from "./importedWorkContentQueries.js";
import { loadPdfExtractionEvidence } from "./pdfExtractionEvidenceQueries.js";
import { addManualWorkSection, updateManualWorkContent } from "./manualWorkContentCommands.js";
import { loadManualWorkForEditing, loadManualWorkUnit } from "./manualWorkContentQueries.js";
import { listWorks, searchAuthors } from "./libraryQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

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

  // Insert a contextual sibling/child in a manual Work and return it opened at that section (#881).
  // Owner/origin/target-scoped (404 otherwise); a stale revision is a 409 and an unsupported relation is 400.
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
        toEntryId(parsed.data.targetUnitEntryId),
        parsed.data.placement,
        parsed.data.revision,
        request.server.currentUser.getCurrentUserId()
      );

      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      if (result.status === "conflict") {
        return reply.code(409).send({ error: "revision_conflict" });
      }

      if (result.status === "invalid_placement") {
        return reply.code(400).send(invalidRequestBody);
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

  // Load one canonical imported Work opened at its first section, with that section's reassembled document
  // and the ordered section list, for the shared Library editor to open in CORRECTION mode (#762). Scoped
  // to `origin = 'imported'` AND fully-canonical `doc_blocks` content: an unknown id, a manual/authored
  // Work, or an imported Work with any legacy-mdast section is 404. No ownership is consulted — in v0 the
  // current-user provider is the sole administrator for shared Library correction.
  server.get<{ Params: WorkParams }>("/api/imported-works/:workEntryId", async (request, reply) => {
    const work = await loadImportedWorkForCorrection(
      dependencies.db,
      toEntryId(request.params.workEntryId)
    );

    if (work === undefined) {
      return reply.code(404).send(notFound);
    }

    return reply.code(200).send(work);
  });

  // Load one section's reassembled canonical document, for the correction editor to open a section the
  // administrator navigated to in the Outline (#762). Origin/eligibility-scoped like the parent Work, and
  // the section must belong to that Work — otherwise 404.
  server.get<{ Params: WorkUnitParams }>(
    "/api/imported-works/:workEntryId/units/:unitEntryId",
    async (request, reply) => {
      const unit = await loadImportedWorkUnit(
        dependencies.db,
        toEntryId(request.params.workEntryId),
        toEntryId(request.params.unitEntryId)
      );

      if (unit === undefined) {
        return reply.code(404).send(notFound);
      }

      return reply.code(200).send(unit);
    }
  );

  // Return the SAFE PDF extraction evidence for a correctable imported Work (#763): each block's page,
  // raw structure label, confidence, OCR provenance, the derived review suggestion, and whether it has
  // been corrected — so the shared editor can guide correction toward the least-certain blocks. Origin/
  // eligibility-scoped exactly like the correction endpoints (404 otherwise). No block id is accepted from
  // the client and no coordinate/image/path is returned; a non-PDF imported Work yields an empty list.
  server.get<{ Params: WorkParams }>(
    "/api/imported-works/:workEntryId/extraction-evidence",
    async (request, reply) => {
      const evidence = await loadPdfExtractionEvidence(
        dependencies.db,
        toEntryId(request.params.workEntryId)
      );

      if (evidence === undefined) {
        return reply.code(404).send(notFound);
      }

      return reply.code(200).send(evidence);
    }
  );

  // Insert a contextual sibling/child in a correctable imported Work and return it opened at that section
  // (#881). Origin/eligibility/target-scoped (404 otherwise); stale is 409 and unsupported placement is 400.
  server.post<{ Params: WorkParams }>(
    "/api/imported-works/:workEntryId/units",
    async (request, reply) => {
      const parsed = addImportedWorkSectionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const result = await addImportedWorkSection(
        dependencies,
        toEntryId(request.params.workEntryId),
        toEntryId(parsed.data.targetUnitEntryId),
        parsed.data.placement,
        parsed.data.revision
      );

      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      if (result.status === "conflict") {
        return reply.code(409).send({ error: "revision_conflict" });
      }

      if (result.status === "invalid_placement") {
        return reply.code(400).send(invalidRequestBody);
      }

      request.log.info(
        {
          route: "POST /api/imported-works/:workEntryId/units",
          unitEntryId: result.work.unitEntryId,
          workEntryId: result.work.entryId
        },
        "imported_work_section_added"
      );

      return reply.code(201).send(result.work);
    }
  );

  // Correct one section's canonical document with work-level revision protection (#762): id-preserving
  // replace scoped to `origin = 'imported'` AND fully-canonical content (404 otherwise), and the section
  // must belong to the Work (404). A malformed/unsafe document is rejected at the boundary (400); a stale
  // revision — another session saved in between — is a 409 and writes nothing. On success the Work marker
  // and per-block `corrected_at` record the correction; an unchanged Save advances the revision only.
  server.put<{ Params: WorkUnitParams }>(
    "/api/imported-works/:workEntryId/units/:unitEntryId/content",
    async (request, reply) => {
      const parsed = correctImportedWorkContentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const result = await correctImportedWorkContent(
        dependencies,
        toEntryId(request.params.workEntryId),
        toEntryId(request.params.unitEntryId),
        parsed.data.document,
        parsed.data.revision
      );

      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      if (result.status === "conflict") {
        return reply.code(409).send({ error: "revision_conflict" });
      }

      request.log.info(
        {
          route: "PUT /api/imported-works/:workEntryId/units/:unitEntryId/content",
          unitEntryId: result.work.unitEntryId,
          workEntryId: result.work.entryId
        },
        "imported_work_corrected"
      );

      return reply.code(200).send(result.work);
    }
  );
}
