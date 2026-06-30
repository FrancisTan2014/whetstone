import {
  upsertReadingPositionRequestSchema,
  type LatestReadingPositionDto,
  type ReadingPositionDto
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  upsertReadingPosition,
  type ReadingPositionDependencies
} from "./readingPositionCommands.js";
import { getLatestReadingPosition, getReadingPosition } from "./readingPositionQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;

export function registerReadingPositionRoutes(
  server: FastifyInstance,
  dependencies: ReadingPositionDependencies
): void {
  server.get("/api/reading-position/latest", async (request) => {
    const stored = await getLatestReadingPosition(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );

    const position: LatestReadingPositionDto | null =
      stored === undefined
        ? null
        : {
            anchorBlockEntryId: stored.anchorBlockEntryId,
            unitEntryId: stored.unitEntryId,
            workEntryId: stored.workEntryId,
            workTitle: stored.workTitle
          };

    return { position };
  });

  server.get<{ Params: WorkParams }>(
    "/api/works/:workEntryId/reading-position",
    async (request) => {
      const stored = await getReadingPosition(
        dependencies.db,
        toEntryId(request.params.workEntryId),
        request.server.currentUser.getCurrentUserId()
      );

      const position: ReadingPositionDto | null =
        stored === undefined
          ? null
          : { anchorBlockEntryId: stored.anchorBlockEntryId, unitEntryId: stored.unitEntryId };

      return { position };
    }
  );

  server.put<{ Params: WorkParams }>(
    "/api/works/:workEntryId/reading-position",
    async (request, reply) => {
      const parsed = upsertReadingPositionRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const workEntryId = toEntryId(request.params.workEntryId);
      await upsertReadingPosition(
        dependencies,
        workEntryId,
        request.server.currentUser.getCurrentUserId(),
        parsed.data
      );

      request.log.info(
        {
          route: "PUT /api/works/:workEntryId/reading-position",
          unitEntryId: parsed.data.unitEntryId,
          workEntryId
        },
        "reading_position_saved"
      );

      return reply.code(204).send();
    }
  );
}
