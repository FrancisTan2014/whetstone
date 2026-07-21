import {
  authorNoteCardRequestSchema,
  editNotePromptQuestionRequestSchema,
  createDirectCardRequestSchema,
  noteReviewRatingRequestSchema,
  setNoteGradingTargetRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import { authorNoteCard } from "./authorNoteCard.js";
import { createDirectCard } from "./createDirectCard.js";
import { rateNotePrompt } from "./notesReviewCommands.js";
import { loadNextDueNotePrompt, loadNotePromptReveal } from "./notesReviewQueries.js";
import {
  addNotePromptCard,
  editNotePromptQuestion,
  pauseNotePrompt,
  removeNotePromptCard,
  restartNotePrompt,
  resumeNotePrompt,
  setNoteGradingTarget,
  type NotePromptSettingsMutationOutcome
} from "./notesReviewSettingsCommands.js";
import { listNotePromptSettings, loadNoteReviewHistoryPage } from "./notesReviewSettingsQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;
const conflict = { error: "conflict" } as const;
const invalidSuccessCheck = { error: "invalid_success_check" } as const;
const legacyReadOnly = { error: "legacy_read_only" } as const;
const restartRequiresCard = { error: "restart_requires_card" } as const;
const promptConflict = { error: "prompt_conflict" } as const;
const invalidQuestion = { error: "invalid_question" } as const;
const invalidAnswer = { error: "invalid_answer" } as const;
const submissionConflict = { error: "submission_conflict" } as const;
const submissionGone = { error: "submission_gone" } as const;

type OwnerNoteReviewParams = Readonly<{ noteEntryId: string }>;

// The Notes-owned Review session needs the database, an id stamp for review events, and a clock. The clock
// is held here (the route layer) and passed into the commands/queries, keeping scheduling deterministic.
export type NotesReviewRouteDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

type PromptParams = Readonly<{ id: string }>;

// The opaque forward cursor a history page echoes to fetch older events; absent on the first page.
type HistoryQuery = Readonly<{ cursor?: string }>;

// Map a settings-mutation outcome to its HTTP reply once, so every settings route answers identically:
// 200 with the refreshed row (logged), 404 when the prompt is not the caller's, 409 on a stale card
// precondition. Centralizing this keeps the six routes to a single line each.
function sendSettingsMutation(
  reply: FastifyReply,
  result: NotePromptSettingsMutationOutcome,
  request: FastifyRequest<{ Params: PromptParams }>,
  route: string
): FastifyReply {
  switch (result.status) {
    case "not_found":
      return reply.code(404).send(notFound);
    case "conflict":
      return reply.code(409).send(conflict);
    case "ok":
      request.log.info({ promptId: request.params.id, route }, "note_review_settings_changed");
      return reply.code(200).send(result.value);
  }
}

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

  // The full Review-settings list for one owned note (#660): every prompt in creation order with its reveal
  // policy and projected card state. 404 when the note is not the caller's or is a Mark. Performs no write.
  server.get<{ Params: OwnerNoteReviewParams }>(
    "/api/notes/:noteEntryId/review/settings",
    async (request, reply) => {
      const value = await listNotePromptSettings(
        dependencies.db,
        request.server.currentUser.getCurrentUserId(),
        toEntryId(request.params.noteEntryId),
        dependencies.now()
      );
      if (value === undefined) {
        return reply.code(404).send(notFound);
      }
      return reply.code(200).send(value);
    }
  );

  // One prompt's append-only Review history, newest first, paged by an opaque cursor (#660). 404 when the
  // prompt is not the caller's; 400 on a malformed cursor. History outlives the card, so a removed prompt's
  // record still reads. Performs no write.
  server.get<{ Params: PromptParams; Querystring: HistoryQuery }>(
    "/api/notes/review/prompts/:id/history",
    async (request, reply) => {
      const result = await loadNoteReviewHistoryPage(
        dependencies.db,
        request.server.currentUser.getCurrentUserId(),
        request.params.id,
        request.query.cursor
      );
      switch (result.status) {
        case "not_found":
          return reply.code(404).send(notFound);
        case "invalid_cursor":
          return reply.code(400).send(invalidRequest);
        case "ok":
          return reply.code(200).send(result.value);
      }
    }
  );

  // Edit one prompt's retrieval question (#660, rich in #687): writes ONLY the cue (rich doc + derived
  // plaintext). 404 when the prompt is not the caller's; 400 on a malformed body or a Question document whose
  // server-derived text is blank. Returns the refreshed settings row.
  server.patch<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/question",
    async (request, reply) => {
      const parsed = editNotePromptQuestionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await editNotePromptQuestion(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId(),
        parsed.data
      );
      switch (result.status) {
        case "not_found":
          return reply.code(404).send(notFound);
        case "conflict":
          return reply.code(409).send(promptConflict);
        case "invalid_question":
          return reply.code(400).send(invalidQuestion);
        case "ok":
          request.log.info(
            { promptId: request.params.id, route: "PATCH /question" },
            "note_review_settings_changed"
          );
          return reply.code(200).send(result.value);
      }
    }
  );

  // Pause one prompt's card (#660): withhold it from the due scan (no FSRS change, no event). 404 when the
  // prompt is not the caller's; 409 when it has no card. Returns the refreshed row.
  server.post<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/pause",
    async (request, reply) => {
      const result = await pauseNotePrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId()
      );
      return sendSettingsMutation(reply, result, request, "POST /pause");
    }
  );

  // Resume one prompt's paused card (#660): return it to the due scan (no FSRS change, no event). 404 when
  // the prompt is not the caller's; 409 when it has no card. Returns the refreshed row.
  server.post<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/resume",
    async (request, reply) => {
      const result = await resumeNotePrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId()
      );
      return sendSettingsMutation(reply, result, request, "POST /resume");
    }
  );

  // Restart one prompt's schedule (#660): reset FSRS state and append one `reset` event through the shared
  // boundary. 404 when the prompt is not the caller's; 409 when it has no card. Returns the refreshed row.
  server.post<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/restart",
    async (request, reply) => {
      const result = await restartNotePrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId()
      );
      return sendSettingsMutation(reply, result, request, "POST /restart");
    }
  );

  // Re-add a cardless prompt to Review (#660): seed a fresh active card due now, reusing the SAME prompt and
  // its preserved history (no event). 404 when the prompt is not the caller's; 409 when it already has a
  // card. Returns the refreshed row.
  server.post<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/card",
    async (request, reply) => {
      const result = await addNotePromptCard(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId()
      );
      return sendSettingsMutation(reply, result, request, "POST /card");
    }
  );

  // Remove one prompt's card from Review (#660): drop the card, KEEP the note and history. 404 when the
  // prompt is not the caller's; 409 when it has no card. Returns the refreshed row.
  server.delete<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/card",
    async (request, reply) => {
      const result = await removeNotePromptCard(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId()
      );
      return sendSettingsMutation(reply, result, request, "DELETE /card");
    }
  );

  // Set one prompt's grading target (#686): declare whether it grades against the live note (`current_note`)
  // or an authored Success check (`expected_response`), and choose `keep` (policy only) or `restart` (policy
  // + a schedule reset through the shared boundary, due now) — atomically. 404 when the prompt is not the
  // caller's; 400 on a malformed request or a blank Success check; 409 when the prompt is `legacy_custom`
  // (read-only here) or a `restart` targets a cardless prompt. Returns the refreshed settings row.
  server.post<{ Params: PromptParams }>(
    "/api/notes/review/prompts/:id/grading-target",
    async (request, reply) => {
      const parsed = setNoteGradingTargetRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }
      const result = await setNoteGradingTarget(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId(),
        parsed.data
      );
      switch (result.status) {
        case "not_found":
          return reply.code(404).send(notFound);
        case "invalid_success_check":
          return reply.code(400).send(invalidSuccessCheck);
        case "legacy_read_only":
          return reply.code(409).send(legacyReadOnly);
        case "restart_requires_card":
          return reply.code(409).send(restartRequiresCard);
        case "conflict":
          return reply.code(409).send(promptConflict);
        case "ok":
          request.log.info(
            {
              promptId: request.params.id,
              route: "POST /api/notes/review/prompts/:id/grading-target"
            },
            "note_review_settings_changed"
          );
          return reply.code(200).send(result.value);
      }
    }
  );

  // Create one review card directly from an authored question/answer pair (#689), retry-safe via the
  // client's stable `submissionId`. One success atomically writes a manual standalone note (from
  // `answerDoc`), one prompt with the chosen reveal kind (its cue is the rich `questionDoc`), one active
  // shared card at the recall retention due now, and one owner-scoped creation receipt — no review event.
  // 400 on a malformed body or a blank Question/Answer/Success-check document; 409 when the same
  // `submissionId` is replayed with a CHANGED payload; 410 when the original note has since been deleted
  // (the receipt is a non-resurrecting tombstone). A same-payload replay returns 200 with the ORIGINAL
  // result. Owner-scoped through the current user, so different owners' submissions are isolated.
  server.post("/api/notes/review/direct-cards", async (request, reply) => {
    const parsed = createDirectCardRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await createDirectCard(
      dependencies,
      request.server.currentUser.getCurrentUserId(),
      parsed.data
    );
    switch (result.status) {
      case "invalid_question":
        return reply.code(400).send(invalidQuestion);
      case "invalid_answer":
        return reply.code(400).send(invalidAnswer);
      case "invalid_success_check":
        return reply.code(400).send(invalidSuccessCheck);
      case "conflict":
        return reply.code(409).send(submissionConflict);
      case "gone":
        return reply.code(410).send(submissionGone);
      case "ok":
        request.log.info(
          { noteId: result.value.noteId, route: "POST /api/notes/review/direct-cards" },
          "note_review_direct_card_created"
        );
        return reply.code(200).send(result.value);
    }
  });

  // Author the FIRST review card over an EXISTING saved note (#687), retry-safe via the client's stable
  // `submissionId`. Unlike direct-cards this never inserts or copies a note — it authors over the learner's
  // already-owned note in place. One success atomically writes one prompt with the chosen reveal kind (its
  // cue is the rich `questionDoc`) and its `contains` link, one active shared card at the recall retention
  // due now, and one owner-scoped creation receipt — no review event, no note write. A note may own many
  // authored cards, so a distinct submission always creates a NEW card. 400 on a malformed body
  // or a blank Question/Success-check document; 404 when the note is not the caller's or is a Mark; 409 when
  // the same `submissionId` is replayed with a CHANGED payload; 410 when the note has since been deleted. A
  // same-payload replay returns 200 with the ORIGINAL result. Owner-scoped through the current user.
  server.post("/api/notes/review/author-cards", async (request, reply) => {
    const parsed = authorNoteCardRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await authorNoteCard(
      dependencies,
      request.server.currentUser.getCurrentUserId(),
      parsed.data
    );
    switch (result.status) {
      case "invalid_question":
        return reply.code(400).send(invalidQuestion);
      case "invalid_success_check":
        return reply.code(400).send(invalidSuccessCheck);
      case "not_found":
        return reply.code(404).send(notFound);
      case "conflict":
        return reply.code(409).send(submissionConflict);
      case "gone":
        return reply.code(410).send(submissionGone);
      case "ok":
        request.log.info(
          { noteId: result.value.noteId, route: "POST /api/notes/review/author-cards" },
          "note_review_authored_card_created"
        );
        return reply.code(200).send(result.value);
    }
  });
}
