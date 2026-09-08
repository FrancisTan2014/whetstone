import {
  explainRequestSchema,
  type ExplainCapability,
  type ExplainResponse
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { explainSelection, type ExplainCommandDependencies } from "./explainCommands.js";

const invalidRequestBody = { error: "invalid_request" } as const;

export type ExplainRouteDependencies = Readonly<{
  // Computed once at boot (opt-in flag + validated config) — a static, truthful read, never a live
  // probe of whether the runtime can actually authenticate right now (#924/#925).
  capability: ExplainCapability;
  explain: ExplainCommandDependencies;
}>;

// Two thin routes: the read-only capability report the Reader (#925) consults before showing its entry
// point, and the one POST that actually resolves a selection into a semantic-map explanation. Neither
// does anything beyond validate → delegate → return; provider selection, caching, and the Copilot
// runtime itself all stay server-side.
export function registerExplainRoutes(
  server: FastifyInstance,
  dependencies: ExplainRouteDependencies
): void {
  server.get("/api/explain/capability", async (_request, reply) => {
    return reply.code(200).send(dependencies.capability);
  });

  server.post("/api/explain", async (request, reply) => {
    const parsed = explainRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const result: ExplainResponse = await explainSelection(dependencies.explain, parsed.data);
    return reply.code(200).send(result);
  });
}
