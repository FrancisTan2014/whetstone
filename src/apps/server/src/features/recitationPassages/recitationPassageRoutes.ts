import {
  recordRecitationReviewRequestSchema,
  splitRecitationPassageRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  loadDueRecitationPassage,
  listRecitationPassages,
  mergeNextRecitationPassage,
  recordRecitationPassageReview,
  seedRecitationPassages,
  splitRecitationPassage,
  type RecitationPassageDependencies
} from "./recitationPassageCommands.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

type PlanParams = Readonly<{ id: string }>;
type PassageParams = Readonly<{ id: string }>;

export type RecitationPassageRouteDependencies = RecitationPassageDependencies;

export function registerRecitationPassageRoutes(
  server: FastifyInstance,
  dependencies: RecitationPassageRouteDependencies
): void {
  // Divide a plan's Work into passages seeded from its source text blocks (idempotent — a second call
  // returns the existing passages). Owner-scoped (404 otherwise).
  server.post<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/passages/seed",
    async (request, reply) => {
      const result = await seedRecitationPassages(
        dependencies,
        toEntryId(request.params.id),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      const code = result.status === "seeded" ? 201 : 200;
      return reply.code(code).send({ passages: result.passages, planEntryId: request.params.id });
    }
  );

  // A plan's passages in reciting order, with each one's review progress. Owner-scoped (404 otherwise).
  server.get<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/passages",
    async (request, reply) => {
      const result = await listRecitationPassages(
        dependencies,
        toEntryId(request.params.id),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send({ passages: result.passages, planEntryId: request.params.id });
    }
  );

  // Today's next due passage across the learner's plans, re-anchored before serving, or null when nothing
  // is due (no overdue wall). Registered before the parametric passage routes so the static path wins.
  server.get("/api/recitation/passages/due", async (request) => {
    const passage = await loadDueRecitationPassage(
      dependencies,
      request.server.currentUser.getCurrentUserId()
    );
    return { passage };
  });

  // Split a passage at a text position. A malformed body is 400; a split outside the passage or on a
  // boundary is 422 `invalid_split`; owner-scoped (404 otherwise).
  server.post<{ Params: PassageParams }>(
    "/api/recitation/passages/:id/split",
    async (request, reply) => {
      const parsed = splitRecitationPassageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await splitRecitationPassage(
        dependencies,
        toEntryId(request.params.id),
        { blockEntryId: parsed.data.atBlockEntryId, offset: parsed.data.atOffset },
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      if (result.status === "invalid") {
        return reply.code(422).send({ error: "invalid_split", reason: result.reason });
      }
      return reply.code(200).send({ passages: result.passages, planEntryId: result.planEntryId });
    }
  );

  // Merge a passage with the next one in reciting order. Owner-scoped (404 otherwise); merging the last
  // passage (no next) is 422 `no_adjacent_passage`.
  server.post<{ Params: PassageParams }>(
    "/api/recitation/passages/:id/merge-next",
    async (request, reply) => {
      const result = await mergeNextRecitationPassage(
        dependencies,
        toEntryId(request.params.id),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      if (result.status === "no_adjacent_passage") {
        return reply.code(422).send({ error: "no_adjacent_passage" });
      }
      return reply.code(200).send({ passages: result.passages, planEntryId: result.planEntryId });
    }
  );

  // Record a self-assessment of a passage (the FSRS rating + the cue strength attempted from). A
  // malformed body is 400; owner-scoped (404 otherwise).
  server.post<{ Params: PassageParams }>(
    "/api/recitation/passages/:id/review",
    async (request, reply) => {
      const parsed = recordRecitationReviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await recordRecitationPassageReview(
        dependencies,
        toEntryId(request.params.id),
        parsed.data.rating,
        parsed.data.cueStrength,
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send({ passage: result.passage });
    }
  );
}
