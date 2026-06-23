import { createNoteRequestSchema } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { createNote, type NotesDependencies } from "./noteCommands.js";
import { listNoteTemplates } from "./noteQueries.js";

const invalidRequestBody = { error: "invalid_request" } as const;

type WorkParams = Readonly<{ workEntryId: string }>;

export function registerNoteRoutes(server: FastifyInstance, dependencies: NotesDependencies): void {
  server.get("/api/note-templates", async () => ({
    templates: await listNoteTemplates(dependencies.db)
  }));

  server.post<{ Params: WorkParams }>(
    "/api/works/:workEntryId/notes",
    async (request, reply) => {
      const parsed = createNoteRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(invalidRequestBody);
      }

      const workEntryId = toEntryId(request.params.workEntryId);
      const result = await createNote(dependencies, workEntryId, parsed.data);

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
    }
  );
}
