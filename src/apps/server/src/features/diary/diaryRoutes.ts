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
import { getLearnerTimeZone } from "../preferences/preferencesQueries.js";
import {
  getVoiceCaptureStatus,
  listActiveVoiceCaptures,
  retryVoiceCapture,
  submitVoiceCapture,
  type VoiceCaptureDependencies
} from "./voiceCaptureCommands.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;
const notFailed = { error: "not_failed" } as const;

// How many days the Timeline returns when the client does not specify a page size.
const DEFAULT_TIMELINE_DAYS = 7;

type EntryParams = Readonly<{ id: string }>;

export type DiaryRouteDependencies = DiaryDependencies & VoiceCaptureDependencies;

export function registerDiaryRoutes(
  server: FastifyInstance,
  dependencies: DiaryRouteDependencies
): void {
  // Capture: save a diary Entry immediately (save-first) and return it. A diary capture journals only —
  // no proposal or Make Durable step blocks or slows it (#571).
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
      userId,
      now
    );
    request.log.info({ diaryEntryId: entry.id, route: "POST /api/diary/entries" }, "diary_created");

    return reply.code(201).send(entry);
  });

  // Async Tap-and-Talk (#565): save the raw audio and create a pending, diary-sourced voice capture
  // immediately, returning its id + `queued` status so the user can record again without waiting for STT.
  // A background worker transcribes → tidies → makes it ready later, auto-detecting the language (#647).
  // The audio bytes arrive as the raw octet-stream body (parsed to a Buffer in `createServer`); there is
  // no capture-language query — the language is detected during transcription, not chosen up front.
  server.post("/api/diary/voice-captures", async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send(invalidRequest);
    }

    const accepted = await submitVoiceCapture(
      dependencies,
      body,
      request.server.currentUser.getCurrentUserId(),
      dependencies.now()
    );
    request.log.info(
      { route: "POST /api/diary/voice-captures", voiceCaptureId: accepted.id },
      "voice_capture_queued"
    );

    return reply.code(202).send(accepted);
  });

  // List the user's active voice captures (queued/transcribing/tidying/failed) so the client rebuilds its
  // pending UI on load/refresh without any local-only queue state (#566). Ready captures are omitted —
  // they already surface in the Timeline. User-scoped; ordered by capture time (oldest first).
  server.get("/api/diary/voice-captures", async (request) => {
    const captures = await listActiveVoiceCaptures(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );
    return { captures };
  });

  // Poll a voice capture's processing status (queued/transcribing/tidying/ready/failed). User-scoped: an
  // unknown id or another user's capture returns 404.
  server.get<{ Params: EntryParams }>("/api/diary/voice-captures/:id", async (request, reply) => {
    const result = await getVoiceCaptureStatus(
      dependencies.db,
      request.params.id,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send(result.capture);
  });

  // Retry a failed voice capture: re-queue it for the worker from the same saved audio. Only a `failed`
  // capture is retryable (409 otherwise); an unknown id is 404.
  server.post<{ Params: EntryParams }>(
    "/api/diary/voice-captures/:id/retry",
    async (request, reply) => {
      const result = await retryVoiceCapture(
        dependencies.db,
        request.params.id,
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }
      if (result.status === "not_failed") {
        return reply.code(409).send(notFailed);
      }
      request.log.info(
        { route: "POST /api/diary/voice-captures/:id/retry", voiceCaptureId: request.params.id },
        "voice_capture_retried"
      );
      return reply.code(200).send(result.capture);
    }
  );

  // The lazy-loaded Timeline: the next page of days (newest-first), bounded by `limit` days and paged via
  // the exclusive `before` day-key cursor.
  server.get("/api/diary/timeline", async (request, reply) => {
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const userId = request.server.currentUser.getCurrentUserId();
    const days = await listTimelinePage(
      dependencies.db,
      userId,
      parsed.data.before,
      parsed.data.limit ?? DEFAULT_TIMELINE_DAYS,
      await getLearnerTimeZone(dependencies.db, userId)
    );

    return { days };
  });

  // The date-jump calendar's marks: which days in the range have ≥1 entry.
  server.get("/api/diary/calendar", async (request, reply) => {
    const parsed = diaryCalendarQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const userId = request.server.currentUser.getCurrentUserId();
    const dates = await listCalendarDates(
      dependencies.db,
      userId,
      parsed.data.from,
      parsed.data.to,
      await getLearnerTimeZone(dependencies.db, userId)
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
      parsed.data.bodyDoc,
      parsed.data.language,
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
