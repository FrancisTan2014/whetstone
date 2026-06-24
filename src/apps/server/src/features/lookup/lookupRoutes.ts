import { lookupRequestSchema, type LookupResponse } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

const invalidRequestBody = { error: "invalid_request" } as const;

export type LookupDependencies = Readonly<{
  lookup: (term: string, language: string) => Promise<LookupResponse>;
}>;

// A thin read-only route: validate the query at the boundary, then delegate to the service
// (provider selection, caching, and the API key all live server-side and never reach the
// client). A no-match is a 200 with `{ found: false }`, not an error.
export function registerLookupRoutes(
  server: FastifyInstance,
  dependencies: LookupDependencies
): void {
  server.get("/api/lookup", async (request, reply) => {
    const parsed = lookupRequestSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const result = await dependencies.lookup(parsed.data.term, parsed.data.language);
    return reply.code(200).send(result);
  });
}
