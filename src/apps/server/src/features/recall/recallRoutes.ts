import { recordRecallReviewRequestSchema } from "@whetstone/contracts";
import type { ReviewGrade } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { recordRecallReview, snoozeRecallItem, type RecallDependencies } from "./recallCommands.js";
import { listDueRecallItems } from "./recallQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

// A small daily cap so a backlog never becomes a wall (PRODUCT "v0 assistant home (Today)"): only the
// most-due items surface today; the rest wait for a later day. Recall stays a gentle proposal, never a
// forced, unbounded pile.
const DAILY_RECALL_CAP = 20;

// The routes need a clock; the commands take `now` explicitly, so the route layer holds the date seam
// (injected like diary's) alongside the shared recall command dependencies.
export type RecallRouteDependencies = RecallDependencies & Readonly<{ now: () => Date }>;

type ItemParams = Readonly<{ id: string }>;

export function registerRecallRoutes(
  server: FastifyInstance,
  dependencies: RecallRouteDependencies
): void {
  // Today's due batch: the user's most-due items, capped. The reader stays calm — recall lives only
  // here, never in the reading surface.
  server.get("/api/recall/due", async (request) => ({
    items: await listDueRecallItems(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now(),
      DAILY_RECALL_CAP
    )
  }));

  // Self-grade: the learner's Again/Hard/Good/Easy is mapped to an SM-2 grade upstream and applied here,
  // advancing the item's interval/ease/due and logging a review row.
  server.post<{ Params: ItemParams }>("/api/recall/items/:id/review", async (request, reply) => {
    const parsed = recordRecallReviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await recordRecallReview(
      dependencies,
      request.params.id,
      parsed.data.grade as ReviewGrade,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }

    request.log.info(
      { recallItemId: result.item.id, route: "POST /api/recall/items/:id/review" },
      "recall_reviewed"
    );

    return reply.code(200).send(result.item);
  });

  // Snooze: defer the item out of today's batch (moves only `due_at`, not the SM-2 state).
  server.post<{ Params: ItemParams }>("/api/recall/items/:id/snooze", async (request, reply) => {
    const result = await snoozeRecallItem(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      request.params.id,
      dependencies.now()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }

    request.log.info(
      { recallItemId: result.item.id, route: "POST /api/recall/items/:id/snooze" },
      "recall_snoozed"
    );

    return reply.code(200).send(result.item);
  });
}
