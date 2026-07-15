import { enrollNoteRequestSchema } from "@whetstone/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { MemoryRouteDependencies } from "./memoryRoutes.js";
import {
  enrollNote,
  enrollPrompt,
  getNoteReview,
  pausePrompt,
  restartPrompt,
  resumePrompt,
  type PromptScheduleResult
} from "./memoryEnrollment.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

type NoteParams = Readonly<{ id: string }>;
type PromptParams = Readonly<{ id: string }>;

// Deliberate review enrollment and post-enrollment schedule control (#575). Review is never automatic:
// a note enters review only through the explicit "Add to review" cue/reveal confirmation, and imported
// prompts land ready-but-cardless until the learner enrolls each one. After enrollment the learner owns
// the schedule — pause, resume, restart — per prompt. Every route is scoped to the current user; a note
// or prompt that is missing or owned by someone else is a 404, so ownership is never leaked.
export function registerMemoryEnrollmentRoutes(
  server: FastifyInstance,
  dependencies: MemoryRouteDependencies
): void {
  // A note's review settings: the note and every prompt under it, each with its card state + status, so
  // the Reader panel / Notes overview can list prompts and offer per-prompt controls.
  server.get<{ Params: NoteParams }>("/api/memory/notes/:id/review", async (request, reply) => {
    const review = await getNoteReview(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      request.params.id
    );
    if (review === undefined) {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send(review);
  });

  // Enroll a note in review from the "Add to review" cue/reveal confirmation. Idempotent: a repeated
  // submit of the same cue/reveal pair never duplicates the prompt, so a double-click is safe.
  server.post<{ Params: NoteParams }>("/api/memory/notes/:id/review", async (request, reply) => {
    const parsed = enrollNoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await enrollNote(
      dependencies,
      request.params.id,
      request.server.currentUser.getCurrentUserId(),
      parsed.data,
      dependencies.now()
    );
    if (result.status !== "enrolled") {
      return reply.code(404).send(notFound);
    }
    request.log.info(
      { noteId: request.params.id, route: "POST /api/memory/notes/:id/review" },
      "memory_note_enrolled"
    );
    return reply.code(200).send(result.review);
  });

  // Enroll a single imported prompt that landed ready-but-cardless: seed its card so it enters review.
  server.post<{ Params: PromptParams }>(
    "/api/memory/prompts/:id/enroll",
    async (request, reply) => {
      const result = await enrollPrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      if (result.status !== "enrolled") {
        // A draft (`not_ready`) or an already-carded prompt (`already_enrolled`) is a state conflict.
        return reply.code(409).send({ error: result.status });
      }
      request.log.info(
        { promptId: result.prompt.promptId, route: "POST /api/memory/prompts/:id/enroll" },
        "memory_prompt_enrolled"
      );
      return reply.code(200).send(result.prompt);
    }
  );

  // Pause / resume / restart one prompt's schedule after enrollment. The three share a response shape.
  const sendScheduleResult = (reply: FastifyReply, result: PromptScheduleResult): FastifyReply => {
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }
    if (result.status !== "updated") {
      return reply.code(409).send({ error: "not_scheduled" });
    }
    return reply.code(200).send(result.prompt);
  };

  server.post<{ Params: PromptParams }>("/api/memory/prompts/:id/pause", async (request, reply) =>
    sendScheduleResult(
      reply,
      await pausePrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      )
    )
  );

  server.post<{ Params: PromptParams }>("/api/memory/prompts/:id/resume", async (request, reply) =>
    sendScheduleResult(
      reply,
      await resumePrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      )
    )
  );

  server.post<{ Params: PromptParams }>("/api/memory/prompts/:id/restart", async (request, reply) =>
    sendScheduleResult(
      reply,
      await restartPrompt(
        dependencies,
        request.params.id,
        request.server.currentUser.getCurrentUserId(),
        dependencies.now()
      )
    )
  );
}
