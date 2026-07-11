import { recordMemoryReviewRequestSchema } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { recordPromptReview, snoozePrompt, type MemoryDependencies } from "./memoryCommands.js";
import { listDuePromptCards } from "./memoryQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

// A small daily cap so a backlog never becomes a wall (PRODUCT "v0 assistant home (Today)"): only the
// most-due prompts surface today; the rest wait for a later day. Recall stays a gentle proposal, never a
// forced, unbounded pile.
const DAILY_RECALL_CAP = 20;

// The routes need a clock; the commands take `now` explicitly, so the route layer holds the date seam
// alongside the shared memory command dependencies.
export type MemoryRouteDependencies = MemoryDependencies & Readonly<{ now: () => Date }>;

type PromptParams = Readonly<{ id: string }>;

// The "Recall" review action (#595) stays functional over Memory prompts until #573 replaces the
// surface: today's due batch, self-grade, and snooze — the same bounded behavior as before, now backed
// by scheduled Memory prompts. Draft prompts never surface here (they carry no card).
export function registerMemoryReviewRoutes(
  server: FastifyInstance,
  dependencies: MemoryRouteDependencies
): void {
  // Today's due batch: the user's most-due scheduled prompts, capped. The reader stays calm — review
  // lives only here, never in the reading surface.
  server.get("/api/recall/due", async (request) => ({
    items: await listDuePromptCards(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now(),
      DAILY_RECALL_CAP
    )
  }));

  // Self-grade: the learner's Again/Hard/Good/Easy rating advances the prompt's FSRS card state / due
  // and logs a review row.
  server.post<{ Params: PromptParams }>(
    "/api/recall/prompts/:id/review",
    async (request, reply) => {
      const parsed = recordMemoryReviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }

      const result = await recordPromptReview(
        dependencies,
        request.params.id,
        parsed.data.rating,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      );
      if (result.status !== "recorded") {
        return reply.code(404).send(notFound);
      }

      request.log.info(
        { promptId: result.prompt.promptId, route: "POST /api/recall/prompts/:id/review" },
        "memory_prompt_reviewed"
      );

      return reply.code(200).send(result.prompt);
    }
  );

  // Snooze: defer the prompt out of today's batch (moves only `due_at`, not the FSRS card state).
  server.post<{ Params: PromptParams }>(
    "/api/recall/prompts/:id/snooze",
    async (request, reply) => {
      const result = await snoozePrompt(
        dependencies.db,
        request.server.currentUser.getCurrentUserId(),
        request.params.id,
        dependencies.now()
      );
      if (result.status !== "snoozed") {
        return reply.code(404).send(notFound);
      }

      request.log.info(
        { promptId: result.prompt.promptId, route: "POST /api/recall/prompts/:id/snooze" },
        "memory_prompt_snoozed"
      );

      return reply.code(200).send(result.prompt);
    }
  );
}
