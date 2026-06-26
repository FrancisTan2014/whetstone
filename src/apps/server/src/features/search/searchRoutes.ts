import { searchRequestSchema } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import { searchBlocks } from "./searchQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

export type SearchDependencies = Readonly<{
  db: DbClient;
}>;

// A thin read-only route: validate the query term at the boundary, then run the block-text
// search. A missing/blank term is a 400; no matches is a 200 with an empty `results` array and
// the normalized query echoed back.
export function registerSearchRoutes(
  server: FastifyInstance,
  dependencies: SearchDependencies
): void {
  server.get("/api/search", async (request, reply) => {
    const parsed = searchRequestSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const results = await searchBlocks(dependencies.db, parsed.data.q);

    return reply.code(200).send({ query: parsed.data.q, results });
  });
}
