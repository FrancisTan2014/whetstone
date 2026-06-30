import type { FastifyInstance } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import { computeReadingNudge, dismissReadingNudge } from "./nudgeCommands.js";

// The routes need the database and a clock; the commands take `now` explicitly, so the route layer
// holds the date seam (injected like recall's / diary's).
export type NudgeRouteDependencies = Readonly<{ db: DbClient; now: () => Date }>;

type ChunkParams = Readonly<{ chunkId: string }>;

export function registerNudgeRoutes(
  server: FastifyInstance,
  dependencies: NudgeRouteDependencies
): void {
  // The current nudge: the top-ranked, non-cooled-down recent reading capture, or an explicit null so
  // the Today card renders nothing (no placeholder). The reader stays calm — the nudge lives only here.
  server.get("/api/nudge", async () => ({
    nudge: await computeReadingNudge(
      dependencies.db,
      server.currentUser.getCurrentUserId(),
      dependencies.now()
    )
  }));

  // Dismiss = cooldown: suppress this chunk for the cooldown window. 204, no body.
  server.post<{ Params: ChunkParams }>("/api/nudge/:chunkId/dismiss", async (request, reply) => {
    await dismissReadingNudge(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      request.params.chunkId,
      dependencies.now()
    );

    request.log.info(
      { chunkId: request.params.chunkId, route: "POST /api/nudge/:chunkId/dismiss" },
      "nudge_dismissed"
    );

    return reply.code(204).send();
  });
}
