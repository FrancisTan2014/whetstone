import { quickCaptureRequestSchema, reviewProposalRequestSchema } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { listPendingCards } from "./cardQueries.js";
import { quickCapture, type QuickCaptureDependencies } from "./captureCommands.js";
import { reviewProposalCard } from "./reviewCommands.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

// The Make Durable route dependencies are the Quick Capture dependencies (id/db/clock + the proposal
// seam); the card query and review command need only the db/id/clock subset.
export type MakeDurableRouteDependencies = QuickCaptureDependencies;

type ReviewParams = Readonly<{ id: string }>;

export function registerMakeDurableRoutes(
  server: FastifyInstance,
  dependencies: MakeDurableRouteDependencies
): void {
  // Typed Quick Capture: save a Timeline entry immediately, then attempt one gated proposal. The
  // response carries the saved entry and, when a proposal passed the gate/dedup, the review card.
  server.post("/api/makedurable/capture", async (request, reply) => {
    const parsed = quickCaptureRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await quickCapture(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    );
    request.log.info(
      {
        makeDurableCard: result.card !== null,
        route: "POST /api/makedurable/capture",
        timelineEntryId: result.timelineEntry.entryId
      },
      "make_durable_capture"
    );

    return reply.code(201).send(result);
  });

  // The pending Make Durable cards for Today (capped, newest first). Empty when nothing is awaiting review.
  server.get("/api/makedurable/cards", async (request) => {
    const cards = await listPendingCards(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );

    return { cards };
  });

  // Act on a card: Save / Edit + Save creates a Recall item; Not-useful-now / Wrong / Ignore records the
  // signal only. A forged or another user's candidate id is a 404.
  server.post<{ Params: ReviewParams }>(
    "/api/makedurable/proposals/:id/review",
    async (request, reply) => {
      const parsed = reviewProposalRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }

      const result = await reviewProposalCard(
        dependencies,
        request.params.id,
        parsed.data,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      );

      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      request.log.info(
        {
          outcome: parsed.data.outcome,
          proposalCandidateId: request.params.id,
          route: "POST /api/makedurable/proposals/:id/review",
          saved: result.status === "saved"
        },
        "make_durable_review"
      );

      return reply.code(200).send({ recallItem: result.recallItem });
    }
  );
}
