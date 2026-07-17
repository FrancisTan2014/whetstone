import { noteReviewRatingRequestSchema } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import { rateNotePrompt } from "./notesReviewCommands.js";
import { loadNextDueNotePrompt, loadNotePromptReveal } from "./notesReviewQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

// The Notes-owned Review session needs the database, an id stamp for review events, and a clock. The clock
// is held here (the route layer) and passed into the commands/queries, keeping scheduling deterministic.
export type NotesReviewRouteDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

type PromptParams = Readonly<{ id: string }>;

// The Notes-owned Review session surface (#657): a two-phase, one-at-a-time review of the user's due Notes
// prompts. `next` presents the single earliest-due prompt's QUESTION only; `reveal` resolves that prompt's
// answer separately (so the question phase can never leak it); `rating` reschedules only that prompt's
// shared card through the existing Review boundary. Every route is owner-scoped and never surfaces paused
// or cardless prompts.
export function registerNotesReviewRoutes(
  server: FastifyInstance,
  dependencies: NotesReviewRouteDependencies
): void {
  // The next due prompt (question phase), or `{ prompt: null }` when nothing is due — the calm
  // "due complete" state. Recomputed from the cards each call; no queue or cursor is persisted.
  server.get("/api/notes/review/next", async (request) => ({
    prompt: await loadNextDueNotePrompt(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    )
  }));

  // The reveal for one prompt, resolved from its persisted discriminant. 404 when the prompt is not the
  // caller's, or has no active card (paused/unenrolled) — those are never revealable. Performs no write.
  server.get<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/reveal",
    async (request, reply) => {
      const reveal = await loadNotePromptReveal(
        dependencies.db,
        request.server.currentUser.getCurrentUserId(),
        request.params.id
      );
      if (reveal === undefined) {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send(reveal);
    }
  );

  // Rate one prompt: advance only that prompt's shared FSRS card and log the review through the existing
  // Review boundary, returning the next scheduled state. 404 when the prompt is not the caller's or has no
  // card; 400 on a malformed rating.
  server.post<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/rating",
    async (request, reply) => {
      const parsed = noteReviewRatingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await rateNotePrompt(
        { createId: dependencies.createId, db: dependencies.db },
        request.params.id,
        parsed.data.rating,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      );
      if (result.status !== "rated") {
        return reply.code(404).send(notFound);
      }
      request.log.info(
        { promptId: request.params.id, route: "POST /api/notes/review/prompts/:id/rating" },
        "note_prompt_reviewed"
      );
      return reply.code(200).send({ remainingDue: result.remainingDue, review: result.review });
    }
  );
}
