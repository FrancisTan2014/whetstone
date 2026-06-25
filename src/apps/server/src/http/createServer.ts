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
import { registerReadingPositionRoutes } from "../features/readingPosition/readingPositionRoutes.js";
import type { ReadingPositionDependencies } from "../features/readingPosition/readingPositionCommands.js";
import { registerLookupRoutes } from "../features/lookup/lookupRoutes.js";
import type { LookupDependencies } from "../features/lookup/lookupRoutes.js";
import { registerImageRoutes } from "../features/images/imageRoutes.js";
import type { ImageDependencies } from "../features/images/imageRoutes.js";
import {
  createDefaultCurrentUserProvider,
  type CurrentUserProvider
} from "../identity/currentUser.js";

// The current-user provider is exposed to every handler as a server decoration, so a request
// reads the current user id via `request.server.currentUser` (never a literal).
declare module "fastify" {
  interface FastifyInstance {
    currentUser: CurrentUserProvider;
  }
}

export type CreateServerOptions = Readonly<{
  content?: ContentDependencies;
  // The identity seam: the source of the current user id for user-owned reads/writes. Defaults to
  // the v0 DEFAULT_USER_ID provider; tests (and future auth) inject their own.
  currentUser?: CurrentUserProvider;
  images?: ImageDependencies;
  library?: LibraryDependencies;
  logger: NonNullable<FastifyServerOptions["logger"]>;
  lookup?: LookupDependencies;
  notes?: NotesDependencies;
  readingPosition?: ReadingPositionDependencies;
}>;

export function createServer(options: CreateServerOptions): FastifyInstance {
  const server = Fastify<RawServerDefault>({
    logger: options.logger,
    requestIdHeader: "x-request-id"
  });

  server.decorate("currentUser", options.currentUser ?? createDefaultCurrentUserProvider());

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

  if (options.readingPosition !== undefined) {
    registerReadingPositionRoutes(server, options.readingPosition);
  }

  if (options.lookup !== undefined) {
    registerLookupRoutes(server, options.lookup);
  }

  if (options.images !== undefined) {
    registerImageRoutes(server, options.images);
  }

  return server;
}
