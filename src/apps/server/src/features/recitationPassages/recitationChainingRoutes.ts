import {
  completeRecitationChainRequestSchema,
  reviewWholeWorkRequestSchema,
  startRecitationChainRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  completeRecitationChain,
  loadRecitationChaining,
  loadRecitationToday,
  reviewWholeWork,
  startRecitationChain,
  type RecitationChainingDependencies
} from "./recitationChainingCommands.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

type PlanParams = Readonly<{ id: string }>;
type ChainParams = Readonly<{ id: string }>;

export type RecitationChainingRouteDependencies = RecitationChainingDependencies;

export function registerRecitationChainingRoutes(
  server: FastifyInstance,
  dependencies: RecitationChainingRouteDependencies
): void {
  // A plan's chaining progress: the contiguous owned prefix, chain eligibility, any active chain, and
  // whole-work maintenance state (all computed live, never a Timeline Entry). Owner-scoped (404).
  server.get<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/chaining",
    async (request, reply) => {
      const result = await loadRecitationChaining(
        dependencies,
        toEntryId(request.params.id),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send({ chaining: result.chaining });
    }
  );

  // Start a contiguous chain session ending at the chosen passage index. A malformed body is 400; a
  // boundary that is too short, out of range, or beyond the owned prefix is 422 `invalid_chain`;
  // owner-scoped (404 otherwise).
  server.post<{ Params: PlanParams }>("/api/recitation/plans/:id/chain", async (request, reply) => {
    const parsed = startRecitationChainRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await startRecitationChain(
      dependencies,
      toEntryId(request.params.id),
      parsed.data.endOrderIndex,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }
    if (result.status === "invalid") {
      return reply.code(422).send({ error: "invalid_chain", reason: result.reason });
    }
    return reply.code(201).send({ chain: result.chain });
  });

  // Complete an active chain, reporting whether recall held or broke at an identified passage. Only an
  // identified passage receives an Again. A malformed body is 400; an identified passage outside the
  // chain is 422 `invalid_outcome`; an already-completed chain is 409 `not_active`; owner-scoped (404).
  server.post<{ Params: ChainParams }>(
    "/api/recitation/chains/:id/complete",
    async (request, reply) => {
      const parsed = completeRecitationChainRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await completeRecitationChain(
        dependencies,
        request.params.id,
        parsed.data.outcome,
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      if (result.status === "not_active") {
        return reply.code(409).send({ error: "not_active" });
      }
      if (result.status === "invalid") {
        return reply.code(422).send({ error: "invalid_outcome", reason: result.reason });
      }
      return reply.code(200).send({ chain: result.chain });
    }
  );

  // Review the plan's whole-work maintenance prompt: the aggregate FSRS rating plus the reveal outcome.
  // A malformed body is 400; a plan whose Work is not yet fully owned (and never reviewed) is 409
  // `not_eligible`; an identified passage outside the Work is 422 `invalid_outcome`; owner-scoped (404).
  server.post<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/whole-work/review",
    async (request, reply) => {
      const parsed = reviewWholeWorkRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await reviewWholeWork(
        dependencies,
        toEntryId(request.params.id),
        parsed.data.rating,
        parsed.data.outcome,
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      if (result.status === "not_eligible") {
        return reply.code(409).send({ error: "not_eligible" });
      }
      if (result.status === "invalid") {
        return reply.code(422).send({ error: "invalid_outcome", reason: result.reason });
      }
      return reply.code(200).send({ wholeWork: result.wholeWork });
    }
  );

  // Today's single recitation action across the learner's plans (due passage > active chain > whole-work
  // > none), so recitation never becomes an overdue wall.
  server.get("/api/recitation/today", async (request) => {
    const today = await loadRecitationToday(
      dependencies,
      request.server.currentUser.getCurrentUserId()
    );
    return { today };
  });
}
