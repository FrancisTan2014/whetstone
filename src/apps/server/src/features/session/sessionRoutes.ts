import {
  audioContentType,
  endSessionRequestSchema,
  submitTurnRequestSchema
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { endSession, startSession, submitTurn, type SessionDependencies } from "./sessionEngine.js";

const invalidRequest = { error: "invalid_request" } as const;

export function registerSessionRoutes(
  server: FastifyInstance,
  dependencies: SessionDependencies
): void {
  server.addContentTypeParser(audioContentType, { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body)
  );

  server.post("/api/session/start", async (request) =>
    startSession(dependencies, request.server.currentUser.getCurrentUserId(), dependencies.now())
  );

  // The STT boundary (#207): the web posts the recorded audio bytes, the server persists them and
  // transcribes via the speech seam. The web submits the returned transcript to the turn endpoint; the
  // typed fallback skips this.
  server.post("/api/session/transcribe", async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send(invalidRequest);
    }

    const path = await dependencies.saveAudio(body);
    const { transcript } = await dependencies.speech.transcribe({ path });
    return { transcript };
  });

  server.post("/api/session/turn", async (request, reply) => {
    const parsed = submitTurnRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const outcome = await submitTurn(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    );
    if (outcome.status === "chunk_not_found") {
      return reply.code(404).send({ error: "chunk_not_found" });
    }

    return outcome.result;
  });

  server.post("/api/session/end", async (request, reply) => {
    const parsed = endSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    return endSession(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    );
  });
}
