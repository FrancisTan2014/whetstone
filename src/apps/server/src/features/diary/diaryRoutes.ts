import {
  createDiaryEntryRequestSchema,
  diaryCalendarQuerySchema,
  timelineQuerySchema,
  updateDiaryEntryRequestSchema
} from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import {
  createDiaryEntry,
  deleteDiaryEntry,
  updateDiaryEntry,
  type DiaryDependencies
} from "./diaryCommands.js";
import { listCalendarDates, listTimelinePage } from "./diaryQueries.js";
import {
  proposeForCapture,
  type CaptureProposalDependencies
} from "../makeDurable/captureCommands.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;

// How many days the Timeline returns when the client does not specify a page size.
const DEFAULT_TIMELINE_DAYS = 7;

type EntryParams = Readonly<{ id: string }>;

export type DiaryRouteDependencies = DiaryDependencies & CaptureProposalDependencies;

export function registerDiaryRoutes(
  server: FastifyInstance,
  dependencies: DiaryRouteDependencies
): void {
  // Capture: save a diary-sourced Timeline entry first, then run the shared Make Durable proposal gate.
  server.post("/api/diary/entries", async (request, reply) => {
    const parsed = createDiaryEntryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const now = dependencies.now();
    const userId = request.server.currentUser.getCurrentUserId();
    const entry = await createDiaryEntry(
      dependencies,
      parsed.data.transcript,
      parsed.data.inputMode,
      parsed.data.language,
      userId,
      now
    );
    const card = await proposeForCapture(
      dependencies,
      parsed.data.transcript,
      userId,
      entry.id,
      now
    );
    request.log.info(
      { diaryEntryId: entry.id, makeDurableCard: card !== null, route: "POST /api/diary/entries" },
      "diary_created"
    );

    return reply.code(201).send({ entry, card });
  });

  // The lazy-loaded Timeline: the next page of days (newest-first), bounded by `limit` days and paged via
  // the exclusive `before` day-key cursor.
  server.get("/api/diary/timeline", async (request, reply) => {
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const days = await listTimelinePage(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      parsed.data.before,
      parsed.data.limit ?? DEFAULT_TIMELINE_DAYS
    );

    return { days };
  });

  // The date-jump calendar's marks: which days in the range have ≥1 entry.
  server.get("/api/diary/calendar", async (request, reply) => {
    const parsed = diaryCalendarQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const dates = await listCalendarDates(
      dependencies.db,
      request.server.currentUser.getCurrentUserId(),
      parsed.data.from,
      parsed.data.to
    );

    return { dates };
  });

  server.patch<{ Params: EntryParams }>("/api/diary/entries/:id", async (request, reply) => {
    const parsed = updateDiaryEntryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await updateDiaryEntry(
      dependencies,
      request.params.id,
      parsed.data.text,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }

    request.log.info(
      { diaryEntryId: result.entry.id, route: "PATCH /api/diary/entries/:id" },
      "diary_updated"
    );

    return reply.code(200).send(result.entry);
  });

  server.delete<{ Params: EntryParams }>("/api/diary/entries/:id", async (request, reply) => {
    const result = await deleteDiaryEntry(
      dependencies,
      request.params.id,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }

    request.log.info(
      { diaryEntryId: request.params.id, route: "DELETE /api/diary/entries/:id" },
      "diary_deleted"
    );

    return reply.code(204).send();
  });
}
