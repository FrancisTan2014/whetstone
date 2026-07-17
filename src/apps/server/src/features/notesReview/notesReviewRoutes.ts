import { enrollNoteRequestSchema, noteReviewRatingRequestSchema } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import {
  enrollNoteInReview,
  enrollNoteInReviewForOwner,
  getNoteReviewStatus,
  getNoteReviewStatusForOwner
} from "./notesReviewEnrollment.js";
import { rateNotePrompt } from "./notesReviewCommands.js";
import { loadNextDueNotePrompt, loadNotePromptReveal } from "./notesReviewQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;
const notEnrollable = { error: "not_enrollable" } as const;
const questionRequired = { error: "question_required" } as const;

type NoteReviewParams = Readonly<{ noteEntryId: string; workEntryId: string }>;

type OwnerNoteReviewParams = Readonly<{ noteEntryId: string }>;

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

  // One saved note's Review status (#658), for the note sheet's Review section: 200 with the objective
  // status (not enrolled / due now / scheduled / paused), or 404 when the note is not the caller's, is
  // unanchored, or is a Mark (no review resource). Performs no write.
  server.get<{ Params: NoteReviewParams }>(
    "/api/works/:workEntryId/notes/:noteEntryId/review",
    async (request, reply) => {
      const result = await getNoteReviewStatus(
        dependencies,
        toEntryId(request.params.workEntryId),
        toEntryId(request.params.noteEntryId),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status !== "ok") {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send(result.value);
    }
  );

  // Add one saved note to Review (#658): idempotently create-or-reuse its current-note prompt and active
  // shared card, returning the resulting objective status. 404 when the note is not the caller's or is
  // unanchored; 409 when it is a Mark (never a retrieval target). Retry/double-submit safe at the command.
  server.post<{ Params: NoteReviewParams }>(
    "/api/works/:workEntryId/notes/:noteEntryId/review/enrollment",
    async (request, reply) => {
      const result = await enrollNoteInReview(
        dependencies,
        toEntryId(request.params.workEntryId),
        toEntryId(request.params.noteEntryId),
        request.server.currentUser.getCurrentUserId()
      );
      switch (result.status) {
        case "not_found":
          return reply.code(404).send(notFound);
        case "not_enrollable":
          return reply.code(409).send(notEnrollable);
        case "ok":
          request.log.info(
            {
              noteEntryId: request.params.noteEntryId,
              route: "POST /api/works/:workEntryId/notes/:noteEntryId/review/enrollment",
              workEntryId: request.params.workEntryId
            },
            "note_review_enrolled"
          );
          return reply.code(200).send(result.value);
      }
    }
  );

  // One owned note's Review status for the Notes home (#659), owner-scoped so a standalone note reads too:
  // 200 with the objective status, or 404 when the note is not the caller's or is a Mark. Performs no write.
  server.get<{ Params: OwnerNoteReviewParams }>(
    "/api/notes/:noteEntryId/review",
    async (request, reply) => {
      const result = await getNoteReviewStatusForOwner(
        dependencies,
        toEntryId(request.params.noteEntryId),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status !== "ok") {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send(result.value);
    }
  );

  // Add any owned note to Review from the Notes home (#659), owner-scoped. An anchored note reuses its exact
  // source server-side (body omitted); a standalone note supplies the question ("What should Whetstone ask
  // you?"). 404 when the note is not the caller's; 409 when it is a Mark; 400 when a standalone note carries
  // no non-blank question. Idempotent/retry-safe at the shared enrollment command.
  server.post<{ Params: OwnerNoteReviewParams }>(
    "/api/notes/:noteEntryId/review/enrollment",
    async (request, reply) => {
      const parsed = enrollNoteRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await enrollNoteInReviewForOwner(
        dependencies,
        toEntryId(request.params.noteEntryId),
        request.server.currentUser.getCurrentUserId(),
        parsed.data.question
      );
      switch (result.status) {
        case "not_found":
          return reply.code(404).send(notFound);
        case "not_enrollable":
          return reply.code(409).send(notEnrollable);
        case "question_required":
          return reply.code(400).send(questionRequired);
        case "ok":
          request.log.info(
            {
              noteEntryId: request.params.noteEntryId,
              route: "POST /api/notes/:noteEntryId/review/enrollment"
            },
            "note_review_enrolled"
          );
          return reply.code(200).send(result.value);
      }
    }
  );
}
