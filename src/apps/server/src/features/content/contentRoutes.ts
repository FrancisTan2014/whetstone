import { ingestMarkdownRequestSchema } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { ingestMarkdown, type ContentDependencies } from "./contentCommands.js";
import {
  loadReadingUnitContent,
  loadWorkAnchorIndex,
  loadWorkStructure,
  locateBlockUnit,
  workExists
} from "./contentQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const workNotFoundBody = { error: "work_not_found" } as const;
const emptyContentBody = { error: "empty_content" } as const;
// A manual-origin Work owns a canonical ProseMirror document edited only through the manual-Work editor
// (#720); legacy Markdown ingestion into it is refused (409) so the two content formats never mix.
const manualWorkUnsupportedBody = { error: "manual_work_unsupported" } as const;
const unitNotFoundBody = { error: "unit_not_found" } as const;
const blockNotFoundBody = { error: "block_not_found" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;
type UnitParams = Readonly<{ unitEntryId: string; workEntryId: string }>;
type BlockParams = Readonly<{ blockEntryId: string; workEntryId: string }>;

export function registerContentRoutes(
  server: FastifyInstance,
  dependencies: ContentDependencies
): void {
  // Imported-EPUB Work creation is routed through the server-owned duplicate-review boundary (#748),
  // registered by `registerWorkCreationRoutes` at `POST /api/works/epub`. There is no second EPUB front
  // door here: a client cannot create around review.

  // Imported-Markdown Work creation is routed through the server-owned duplicate-review boundary
  // (#747), registered by `registerWorkCreationRoutes` at `POST /api/works/markdown`. There is no
  // second Markdown front door here: a client cannot create around review.
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

    if (result.status === "manual_work_unsupported") {
      return reply.code(409).send(manualWorkUnsupportedBody);
    }

    // Markdown with no readable blocks (e.g. image-only input) is unsupported content, not an
    // empty success — surface it so the panel can show an explicit message.
    if (result.status === "empty_content") {
      return reply.code(422).send(emptyContentBody);
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

  // The work's anchor index: every addressable block reachable by a source-HTML id, keyed by
  // (sourceFile, anchor), so the reader builds a work-scoped resolver that jumps a cross-reference
  // cross-unit (#366). 404 for an unknown work.
  server.get<{ Params: WorkParams }>("/api/works/:workEntryId/anchors", async (request, reply) => {
    const workEntryId = toEntryId(request.params.workEntryId);

    if (!(await workExists(dependencies.db, workEntryId))) {
      return reply.code(404).send(workNotFoundBody);
    }

    return loadWorkAnchorIndex(dependencies.db, workEntryId);
  });

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
}
