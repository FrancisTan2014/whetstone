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

export type CreateServerOptions = Readonly<{
  logger: NonNullable<FastifyServerOptions["logger"]>;
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

  return server;
}
