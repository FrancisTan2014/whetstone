import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type RawServerDefault
} from "fastify";

import {
  createHealthResponse,
  healthEndpointPath,
  healthResponseJsonSchema,
  type HealthResponse
} from "@whetstone/contracts";

import { registerLibraryRoutes } from "../features/library/libraryRoutes.js";
import type { LibraryDependencies } from "../features/library/libraryCommands.js";
import { registerContentRoutes } from "../features/content/contentRoutes.js";
import type { ContentDependencies } from "../features/content/contentCommands.js";
import { registerNoteRoutes } from "../features/notes/noteRoutes.js";
import type { NotesDependencies } from "../features/notes/noteCommands.js";

export type CreateServerOptions = Readonly<{
  content?: ContentDependencies;
  library?: LibraryDependencies;
  logger: NonNullable<FastifyServerOptions["logger"]>;
  notes?: NotesDependencies;
}>;

export function createServer(options: CreateServerOptions): FastifyInstance {
  const server = Fastify<RawServerDefault>({
    logger: options.logger,
    requestIdHeader: "x-request-id"
  });

  server.get(
    healthEndpointPath,
    {
      schema: {
        response: {
          200: healthResponseJsonSchema
        }
      }
    },
    async (): Promise<HealthResponse> => createHealthResponse()
  );

  if (options.library !== undefined) {
    registerLibraryRoutes(server, options.library);
  }

  if (options.content !== undefined) {
    registerContentRoutes(server, options.content);
  }

  if (options.notes !== undefined) {
    registerNoteRoutes(server, options.notes);
  }

  return server;
}
