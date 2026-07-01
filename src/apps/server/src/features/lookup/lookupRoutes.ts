import {
  lookupRequestSchema,
  type LookupResponse,
  type LookupSourceId
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

const invalidRequestBody = { error: "invalid_request" } as const;

export type LookupDependencies = Readonly<{
  lookup: (
    term: string,
    language: string,
    source: LookupSourceId,
    context?: string
  ) => Promise<LookupResponse>;
}>;

// A thin read-only route: validate the query at the boundary, then delegate to the service for the
// one requested source (provider selection, caching, and the API key all live server-side and never
// reach the client). The optional `context` (the selection's block text) is threaded through for the
// local-LLM source (#341). A no-match is a 200 with `{ found: false }`, not an error.
export function registerLookupRoutes(
  server: FastifyInstance,
  dependencies: LookupDependencies
): void {
  server.get("/api/lookup", async (request, reply) => {
    const parsed = lookupRequestSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const result = await dependencies.lookup(
      parsed.data.term,
      parsed.data.language,
      parsed.data.source,
      parsed.data.context
    );
    return reply.code(200).send(result);
  });
}
