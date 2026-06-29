import {
  defaultPreferences,
  upsertPreferencesRequestSchema,
  type PreferencesDto
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { upsertPreferences, type PreferencesDependencies } from "./preferencesCommands.js";
import { getPreferences } from "./preferencesQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

// User-owned reader preferences (#234): GET returns the stored record (or defaults when none); PUT
// upserts. The current user is the v0 default identity; the record is work-independent.
export function registerPreferencesRoutes(
  server: FastifyInstance,
  dependencies: PreferencesDependencies
): void {
  server.get("/api/preferences", async (request) => {
    const stored = await getPreferences(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );

    const preferences: PreferencesDto =
      stored === undefined
        ? defaultPreferences
        : ({ readingSize: stored.readingSize, theme: stored.theme } as PreferencesDto);

    return { preferences };
  });

  server.put("/api/preferences", async (request, reply) => {
    const parsed = upsertPreferencesRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    await upsertPreferences(
      dependencies,
      request.server.currentUser.getCurrentUserId(),
      parsed.data
    );
    return reply.code(204).send();
  });
}
