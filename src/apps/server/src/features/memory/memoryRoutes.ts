import {
  addMemoryPromptRequestSchema,
  depositMemoryRequestSchema,
  editMemoryNoteRequestSchema,
  editMemoryPromptRequestSchema,
  recordMemoryReviewRequestSchema
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import {
  addPromptToNote,
  deleteMemoryNote,
  depositMemory,
  editMemoryNote,
  editMemoryPrompt,
  recordPromptReview,
  snoozePrompt,
  type MemoryDependencies
} from "./memoryCommands.js";
import {
  getMemoryNoteDetail,
  listDuePromptCards,
  listMemoryNotes,
  searchMemoryNotes
} from "./memoryQueries.js";

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

type NoteParams = Readonly<{ id: string }>;
type NotesQuery = Readonly<{ q?: string }>;
type SuggestQuery = Readonly<{ term?: string }>;

// The Memory surface (#573): the learner's own notes and their prompts — list, search, detail, create,
// edit, add-direction, delete, and an offline-dictionary suggestion for Quick Add. Every route is scoped
// to the current user; a note or prompt that is missing or owned by someone else is a 404, so ownership
// is never leaked. Creation reuses the shared `depositMemory` path, so a Memory a learner types by hand
// and a deposit from practice/tools are the same first-class note.
export function registerMemoryRoutes(
  server: FastifyInstance,
  dependencies: MemoryRouteDependencies
): void {
  // The Memory list, or a note-centric search when `q` is given. Both return jargon-free summaries.
  server.get<{ Querystring: NotesQuery }>("/api/memory/notes", async (request) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const query = request.query.q;
    const items =
      query === undefined || query.trim().length === 0
        ? await listMemoryNotes(dependencies.db, userId, dependencies.now())
        : await searchMemoryNotes(dependencies.db, userId, query, dependencies.now());
    return { items };
  });

  // One note's full detail: the note plus every prompt (draft or scheduled) under it.
  server.get<{ Params: NoteParams }>("/api/memory/notes/:id", async (request, reply) => {
    const detail = await getMemoryNoteDetail(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      request.params.id
    );
    if (detail === undefined) {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send(detail);
  });

  // Create a Memory: one note and one-or-more retrieval directions (a bare term may request an offline
  // gloss suggestion; an answerless direction saves as an unscheduled draft).
  server.post("/api/memory/notes", async (request, reply) => {
    const parsed = depositMemoryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const deposit = await depositMemory(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    );
    request.log.info(
      { noteId: deposit.note.noteId, route: "POST /api/memory/notes" },
      "memory_note_created"
    );
    return reply.code(201).send(deposit);
  });

  // Edit a note's durable body. Editing content never resets any prompt's review history.
  server.patch<{ Params: NoteParams }>("/api/memory/notes/:id", async (request, reply) => {
    const parsed = editMemoryNoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await editMemoryNote(
      dependencies,
      request.params.id,
      request.server.currentUser.getCurrentUserId(),
      parsed.data.noteText,
      dependencies.now()
    );
    if (result.status !== "updated") {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send(result.detail);
  });

  // Delete a note and everything under it (prompts, reviews, schedule, links) atomically.
  server.delete<{ Params: NoteParams }>("/api/memory/notes/:id", async (request, reply) => {
    const result = await deleteMemoryNote(
      dependencies,
      request.params.id,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status !== "deleted") {
      return reply.code(404).send(notFound);
    }
    request.log.info(
      { noteId: request.params.id, route: "DELETE /api/memory/notes/:id" },
      "memory_note_deleted"
    );
    return reply.code(204).send();
  });

  // Add one additional retrieval direction to an existing note.
  server.post<{ Params: NoteParams }>("/api/memory/notes/:id/prompts", async (request, reply) => {
    const parsed = addMemoryPromptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await addPromptToNote(
      dependencies,
      request.params.id,
      request.server.currentUser.getCurrentUserId(),
      parsed.data,
      dependencies.now()
    );
    if (result.status !== "added") {
      return reply.code(404).send(notFound);
    }
    return reply.code(201).send(result.detail);
  });

  // Edit one prompt's cue/answer, reconciling with its schedule (keep card / seed / revert to draft).
  server.patch<{ Params: NoteParams }>("/api/memory/prompts/:id", async (request, reply) => {
    const parsed = editMemoryPromptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }
    const result = await editMemoryPrompt(
      dependencies,
      request.params.id,
      request.server.currentUser.getCurrentUserId(),
      parsed.data,
      dependencies.now()
    );
    if (result.status !== "updated") {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send(result.prompt);
  });

  // Quick Add's offline suggestion: a bundled-dictionary back for a bare term, or null when unknown (the
  // learner then saves it as a draft). Never blocks capture; absent glosser means null.
  server.get<{ Querystring: SuggestQuery }>("/api/memory/suggest", async (request, reply) => {
    const term = request.query.term;
    if (term === undefined || term.trim().length === 0) {
      return reply.code(400).send(invalidRequest);
    }
    const suggestion =
      dependencies.resolveOfflineGloss === undefined
        ? null
        : await dependencies.resolveOfflineGloss(term);
    return reply.code(200).send({ term, suggestion });
  });
}
