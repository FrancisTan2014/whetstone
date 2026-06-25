import { createNoteRequestSchema, updateNoteRequestSchema } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { createNote, deleteNote, updateNote, type NotesDependencies } from "./noteCommands.js";
import { listNoteTemplates, listNotesForWork } from "./noteQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;

type NoteParams = Readonly<{ noteEntryId: string; workEntryId: string }>;

export function registerNoteRoutes(server: FastifyInstance, dependencies: NotesDependencies): void {
  server.get("/api/note-templates", async () => ({
    templates: await listNoteTemplates(dependencies.db)
  }));

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
      case "template_not_found":
        return reply.code(400).send({ error: "template_not_found" });
      case "invalid_answers":
        return reply.code(400).send({ error: "invalid_answers", reason: result.reason });
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
        case "template_not_found":
          return reply.code(400).send({ error: "template_not_found" });
        case "invalid_answers":
          return reply.code(400).send({ error: "invalid_answers", reason: result.reason });
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
