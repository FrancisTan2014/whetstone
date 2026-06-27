import type { FastifyInstance } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import { compileProgressMap } from "./mapQueries.js";

// `now` is injected so the route is deterministic in tests; in production it is `() => new Date()`.
export type MapDependencies = Readonly<{
  db: DbClient;
  now: () => Date;
}>;

export function registerMapRoutes(server: FastifyInstance, dependencies: MapDependencies): void {
  server.get("/api/progress-map", async (request) =>
    compileProgressMap(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    )
  );
}
