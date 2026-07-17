import {
  createMarkRequestSchema,
  createNoteRequestSchema,
  createStandaloneNoteRequestSchema,
  updateNoteRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  createMark,
  createNote,
  createStandaloneNote,
  deleteNote,
  deleteNoteForOwner,
  updateNote,
  updateNoteForOwner,
  type NotesDependencies
} from "./noteCommands.js";
import { getNoteForOwner, listNotesForUser, listNotesForWork } from "./noteQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;

type NoteParams = Readonly<{ noteEntryId: string; workEntryId: string }>;

type OwnerNoteParams = Readonly<{ noteEntryId: string }>;

type NotesQuery = Readonly<{ search?: string; work?: string }>;

export function registerNoteRoutes(server: FastifyInstance, dependencies: NotesDependencies): void {
  // Every note the current user owns — the single Notes home (#659). One continuous list in recency order,
  // each note once, with its rolled-up Review projection. `?work=<id>` narrows to anchored notes in that
  // work; `?search=<q>` restricts to notes matching across body, anchor snapshot, prompt questions, and
  // legacy answers. Neither changes the order.
  server.get<{ Querystring: NotesQuery }>("/api/notes", async (request) => ({
    notes: await listNotesForUser(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now(),
      {
        search: request.query.search,
        workEntryId: request.query.work === undefined ? undefined : toEntryId(request.query.work)
      }
    )
  }));

  // One owned note by id (#659), owner-scoped so a standalone note reads too. 404 when it is not the
  // caller's (a forged or cross-user id).
  server.get<{ Params: OwnerNoteParams }>("/api/notes/:noteEntryId", async (request, reply) => {
    const note = await getNoteForOwner(
      dependencies.db,
      toEntryId(request.params.noteEntryId),
      request.server.currentUser.getCurrentUserId()
    );

    if (note === undefined) {
      return reply.code(404).send({ error: "note_not_found" });
    }

    return reply.code(200).send(note);
  });

  // Create a standalone note (#659): one non-blank rich body, no anchor. Persists a `kind = note`,
  // `capture_source = manual` aggregate with no prompt/card/event.
  server.post("/api/notes", async (request, reply) => {
    const parsed = createStandaloneNoteRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const result = await createStandaloneNote(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );

    request.log.info(
      { noteEntryId: result.note.entryId, route: "POST /api/notes" },
      "standalone_note_created"
    );

    return reply.code(201).send(result.note);
  });

  // Edit any owned note's canonical body (#659), owner-scoped. 404 for a forged/cross-user id; 409 for a
  // bodyless Mark.
  server.patch<{ Params: OwnerNoteParams }>("/api/notes/:noteEntryId", async (request, reply) => {
    const parsed = updateNoteRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const noteEntryId = toEntryId(request.params.noteEntryId);
    const result = await updateNoteForOwner(
      dependencies,
      noteEntryId,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );

    switch (result.status) {
      case "note_not_found":
        return reply.code(404).send({ error: "note_not_found" });
      case "note_not_editable":
        return reply.code(409).send({ error: "note_not_editable" });
      case "updated":
        request.log.info(
          { noteEntryId: result.note.entryId, route: "PATCH /api/notes/:noteEntryId" },
          "note_updated"
        );

        return reply.code(200).send(result.note);
    }
  });

  // Delete any owned note (#659) through the owner-scoped cascade, owner-scoped. 404 for a forged/cross-user
  // id.
  server.delete<{ Params: OwnerNoteParams }>("/api/notes/:noteEntryId", async (request, reply) => {
    const noteEntryId = toEntryId(request.params.noteEntryId);
    const result = await deleteNoteForOwner(
      dependencies,
      noteEntryId,
      request.server.currentUser.getCurrentUserId()
    );

    if (result.status === "note_not_found") {
      return reply.code(404).send({ error: "note_not_found" });
    }

    request.log.info({ noteEntryId, route: "DELETE /api/notes/:noteEntryId" }, "note_deleted");

    return reply.code(204).send();
  });

  server.get<{ Params: WorkParams }>("/api/works/:workEntryId/notes", async (request) => ({
    notes: await listNotesForWork(
      dependencies.db,
      toEntryId(request.params.workEntryId),
      request.server.currentUser.getCurrentUserId()
    )
  }));

  server.post<{ Params: WorkParams }>("/api/works/:workEntryId/notes", async (request, reply) => {
    const parsed = createNoteRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const workEntryId = toEntryId(request.params.workEntryId);
    const result = await createNote(
      dependencies,
      workEntryId,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );

    switch (result.status) {
      case "anchor_out_of_range":
        return reply.code(400).send({ error: "anchor_out_of_range" });
      case "block_not_found":
        return reply.code(404).send({ error: "block_not_found" });
      case "created":
        request.log.info(
          {
            blockEntryId: result.note.blockEntryId,
            noteEntryId: result.note.entryId,
            route: "POST /api/works/:workEntryId/notes",
            workEntryId
          },
          "note_created"
        );

        return reply.code(201).send(result.note);
    }
  });

  server.post<{ Params: WorkParams }>("/api/works/:workEntryId/marks", async (request, reply) => {
    const parsed = createMarkRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const workEntryId = toEntryId(request.params.workEntryId);
    const result = await createMark(
      dependencies,
      workEntryId,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );

    switch (result.status) {
      case "anchor_out_of_range":
        return reply.code(400).send({ error: "anchor_out_of_range" });
      case "block_not_found":
        return reply.code(404).send({ error: "block_not_found" });
      case "created":
        request.log.info(
          {
            blockEntryId: result.note.blockEntryId,
            noteEntryId: result.note.entryId,
            route: "POST /api/works/:workEntryId/marks",
            workEntryId
          },
          "mark_created"
        );

        return reply.code(201).send(result.note);
    }
  });

  server.patch<{ Params: NoteParams }>(
    "/api/works/:workEntryId/notes/:noteEntryId",
    async (request, reply) => {
      const parsed = updateNoteRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const workEntryId = toEntryId(request.params.workEntryId);
      const noteEntryId = toEntryId(request.params.noteEntryId);
      const result = await updateNote(
        dependencies,
        workEntryId,
        noteEntryId,
        parsed.data,
        request.server.currentUser.getCurrentUserId()
      );

      switch (result.status) {
        case "note_not_found":
          return reply.code(404).send({ error: "note_not_found" });
        case "note_not_editable":
          return reply.code(409).send({ error: "note_not_editable" });
        case "updated":
          request.log.info(
            {
              noteEntryId: result.note.entryId,
              route: "PATCH /api/works/:workEntryId/notes/:noteEntryId",
              workEntryId
            },
            "note_updated"
          );

          return reply.code(200).send(result.note);
      }
    }
  );

  server.delete<{ Params: NoteParams }>(
    "/api/works/:workEntryId/notes/:noteEntryId",
    async (request, reply) => {
      const workEntryId = toEntryId(request.params.workEntryId);
      const noteEntryId = toEntryId(request.params.noteEntryId);
      const result = await deleteNote(
        dependencies,
        workEntryId,
        noteEntryId,
        request.server.currentUser.getCurrentUserId()
      );

      if (result.status === "note_not_found") {
        return reply.code(404).send({ error: "note_not_found" });
      }

      request.log.info(
        {
          noteEntryId,
          route: "DELETE /api/works/:workEntryId/notes/:noteEntryId",
          workEntryId
        },
        "note_deleted"
      );

      return reply.code(204).send();
    }
  );
}
