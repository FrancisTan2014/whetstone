import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  TimelineDto,
  VoiceCaptureAcceptedDto,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { diaryEntries, entries, personalEntries } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { createFakeSpeechInput } from "../../speech/fakeSpeechInput.js";
import type { SpeechAudio, SpeechInput } from "../../speech/speechInput.js";
import { listDiaryEntriesForUser } from "./diaryQueries.js";
import { listActiveVoiceCaptures } from "./voiceCaptureCommands.js";
import type { DiaryTidy } from "./diaryTidy.js";
import type { DiaryRouteDependencies } from "./diaryRoutes.js";
import {
  processNextVoiceCapture,
  requeueStalledVoiceCaptures,
  type VoiceCaptureWorkerDependencies
} from "./voiceCaptureWorker.js";

const OTHER_USER_ID = "user-other";

// A deterministic tidy: drop standalone "um"/"uh" fillers, preserve every other word in order — the
// tidy-not-polish invariant. Used to prove the ready entry's body is built from the TIDIED transcript.
function fakeTidy(transcript: string): string {
  return transcript
    .split(/\s+/)
    .filter((token) => token.length > 0 && !["um", "uh"].includes(token.toLowerCase()))
    .join(" ");
}

const throwingSpeech: SpeechInput = {
  transcribe: () => Promise.reject(new Error("whisper crashed"))
};

// Rejects with a non-Error value so the worker's `describeError` fallback (String(error)) is exercised.
const throwingNonErrorSpeech: SpeechInput = {
  transcribe: () => Promise.reject("stt offline")
};

type WorkerOverrides = Readonly<{
  speech?: SpeechInput;
  tidy?: DiaryTidy;
}>;

function buildWorker(
  db: DbClient,
  overrides: WorkerOverrides = {}
): VoiceCaptureWorkerDependencies {
  return {
    db,
    speech:
      overrides.speech ?? createFakeSpeechInput({ transcript: "the deploy is green", words: [] }),
    tidy: overrides.tidy ?? ((transcript) => Promise.resolve(fakeTidy(transcript)))
  };
}

// Seed a queued/in-flight/ready voice capture as its three Entry facets (owning Entry + shared
// personal-entry chronology + diary facet). A voice capture's durable body is empty until the worker
// fills it; a ready seed supplies its `bodyText` directly.
async function seedVoiceCapture(
  db: DbClient,
  row: Readonly<{
    bodyText?: string;
    id: string;
    language?: "zh" | "en" | null;
    occurredAt: string;
    processingStatus: "queued" | "transcribing" | "tidying" | "ready" | "failed";
    rawAudioPath?: string | null;
    tidiedText?: string | null;
    userId?: string;
  }>
): Promise<void> {
  const at = new Date(row.occurredAt);
  const bodyText = row.bodyText ?? "";
  await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: row.id, type: "diary_entry" });
    await tx.insert(personalEntries).values({
      createdAt: at,
      entryId: row.id,
      occurredAt: at,
      updatedAt: at,
      userId: row.userId ?? DEFAULT_USER_ID
    });
    await tx.insert(diaryEntries).values({
      bodyDoc: createTextDocument(bodyText),
      bodyText,
      entryId: row.id,
      failureReason: null,
      inputMode: "voice",
      language: row.language === undefined ? "en" : row.language,
      processingStatus: row.processingStatus,
      rawAudioPath: row.rawAudioPath === undefined ? `audio-${row.id}` : row.rawAudioPath,
      rawTranscript: null,
      tidiedText: row.tidiedText ?? null
    });
  });
}

async function readRow(db: DbClient, id: string) {
  const [row] = await db.select().from(diaryEntries).where(eq(diaryEntries.entryId, id)).limit(1);
  return row;
}

async function requeueToQueued(db: DbClient, id: string): Promise<void> {
  await db
    .update(diaryEntries)
    .set({ processingStatus: "queued" })
    .where(eq(diaryEntries.entryId, id));
}

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

type RouteContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
}>;

let route: RouteContext;

async function buildRouteContext(): Promise<RouteContext> {
  const db = await buildDb();
  let sequence = 0;
  const diary: DiaryRouteDependencies = {
    createId: () => `vc-${(sequence += 1)}`,
    db,
    now: () => new Date("2026-07-09T10:00:00.000Z"),
    saveAudio: (audio) => Promise.resolve(`voice-captures/${audio.length}.audio`)
  };
  return { db, server: createServer({ diary, logger: false }) };
}

async function submit(language = "en", body = "clip-bytes"): Promise<VoiceCaptureAcceptedDto> {
  const response = await route.server.inject({
    method: "POST",
    url: `/api/diary/voice-captures?language=${language}`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(body)
  });
  expect(response.statusCode).toBe(202);
  return response.json() as VoiceCaptureAcceptedDto;
}

async function getStatus(id: string): Promise<{ code: number; body: VoiceCaptureStatusDto }> {
  const response = await route.server.inject({
    method: "GET",
    url: `/api/diary/voice-captures/${id}`
  });
  return { code: response.statusCode, body: response.json() as VoiceCaptureStatusDto };
}

async function listActive(): Promise<{
  code: number;
  captures: ReadonlyArray<VoiceCaptureStatusDto>;
}> {
  const response = await route.server.inject({ method: "GET", url: "/api/diary/voice-captures" });
  return {
    code: response.statusCode,
    captures: (response.json() as { captures: ReadonlyArray<VoiceCaptureStatusDto> }).captures
  };
}

async function timelineIds(): Promise<ReadonlyArray<string>> {
  const response = await route.server.inject({ method: "GET", url: "/api/diary/timeline" });
  const page = response.json() as TimelineDto;
  return page.days.flatMap((day) => day.entries.map((entry) => entry.entryId));
}

describe("processNextVoiceCapture", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  it("is idle when nothing is queued", async () => {
    expect(await processNextVoiceCapture(buildWorker(db))).toEqual({ status: "idle" });
  });

  it("transcribes, tidies, and builds the ready capture's rich body from the tidied transcript", async () => {
    await seedVoiceCapture(db, {
      id: "cap-1",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const speech = createFakeSpeechInput({ transcript: "um the deploy is green", words: [] });

    const result = await processNextVoiceCapture(buildWorker(db, { speech }));

    expect(result).toEqual({ status: "processed", id: "cap-1" });
    const row = await readRow(db, "cap-1");
    expect(row.processingStatus).toBe("ready");
    expect(row.rawTranscript).toBe("um the deploy is green");
    expect(row.tidiedText).toBe("the deploy is green");
    expect(row.bodyText).toBe("the deploy is green");
    expect(row.failureReason).toBeNull();
  });

  it("selects the oldest queued capture first", async () => {
    await seedVoiceCapture(db, {
      id: "newer",
      occurredAt: "2026-07-09T09:05:00.000Z",
      processingStatus: "queued"
    });
    await seedVoiceCapture(db, {
      id: "older",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });

    const result = await processNextVoiceCapture(buildWorker(db));

    expect(result).toMatchObject({ status: "processed", id: "older" });
    expect((await readRow(db, "newer")).processingStatus).toBe("queued");
  });

  it("marks a capture failed and keeps its audio when transcription throws", async () => {
    await seedVoiceCapture(db, {
      id: "cap-fail",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-keepme"
    });

    const result = await processNextVoiceCapture(buildWorker(db, { speech: throwingSpeech }));

    expect(result).toEqual({ status: "failed", id: "cap-fail", reason: "whisper crashed" });
    const row = await readRow(db, "cap-fail");
    expect(row.processingStatus).toBe("failed");
    expect(row.failureReason).toBe("whisper crashed");
    expect(row.rawAudioPath).toBe("audio-keepme");
  });

  it("stringifies a non-Error transcription failure into the capture's reason", async () => {
    await seedVoiceCapture(db, {
      id: "cap-str",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });

    const result = await processNextVoiceCapture(
      buildWorker(db, { speech: throwingNonErrorSpeech })
    );

    expect(result).toEqual({ status: "failed", id: "cap-str", reason: "stt offline" });
    expect((await readRow(db, "cap-str")).failureReason).toBe("stt offline");
  });

  it("transcribes a capture with no language using only the audio path", async () => {
    await seedVoiceCapture(db, {
      id: "cap-nolang",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      language: null
    });
    let seenAudio: SpeechAudio | undefined;
    const speech: SpeechInput = {
      transcribe: (audio) => {
        seenAudio = audio;
        return Promise.resolve({ transcript: "the deploy is green", words: [] });
      }
    };

    const result = await processNextVoiceCapture(buildWorker(db, { speech }));

    expect(result).toMatchObject({ status: "processed", id: "cap-nolang" });
    expect(seenAudio).toEqual({ path: "audio-cap-nolang" });
    const row = await readRow(db, "cap-nolang");
    expect(row.processingStatus).toBe("ready");
    expect(row.language).toBeNull();
  });

  it("fails a capture whose transcript is empty rather than persisting a hollow ready entry", async () => {
    await seedVoiceCapture(db, {
      id: "cap-empty",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const speech = createFakeSpeechInput({ transcript: "   ", words: [] });

    const result = await processNextVoiceCapture(buildWorker(db, { speech }));

    expect(result).toEqual({ status: "failed", id: "cap-empty", reason: "empty_transcript" });
    expect((await readRow(db, "cap-empty")).processingStatus).toBe("failed");
  });

  it("fails a capture with no saved audio path", async () => {
    await seedVoiceCapture(db, {
      id: "cap-noaudio",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: null
    });

    const result = await processNextVoiceCapture(buildWorker(db));

    expect(result).toEqual({ status: "failed", id: "cap-noaudio", reason: "missing_audio" });
  });

  it("re-runs cleanly when a ready capture is requeued (no proposal or duplicate side effect)", async () => {
    await seedVoiceCapture(db, {
      id: "cap-rerun",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const worker = buildWorker(db);

    await processNextVoiceCapture(worker);
    await requeueToQueued(db, "cap-rerun");
    const second = await processNextVoiceCapture(worker);

    expect(second).toEqual({ status: "processed", id: "cap-rerun" });
    expect((await readRow(db, "cap-rerun")).processingStatus).toBe("ready");
  });
});

describe("requeueStalledVoiceCaptures", () => {
  it("requeues only in-flight captures a dead worker left behind", async () => {
    const db = await buildDb();
    await seedVoiceCapture(db, {
      id: "s-transcribing",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "transcribing"
    });
    await seedVoiceCapture(db, {
      id: "s-tidying",
      occurredAt: "2026-07-09T09:01:00.000Z",
      processingStatus: "tidying"
    });
    await seedVoiceCapture(db, {
      id: "s-ready",
      occurredAt: "2026-07-09T09:02:00.000Z",
      processingStatus: "ready"
    });
    await seedVoiceCapture(db, {
      id: "s-failed",
      occurredAt: "2026-07-09T09:03:00.000Z",
      processingStatus: "failed"
    });

    const requeued = await requeueStalledVoiceCaptures(db);

    expect(requeued).toBe(2);
    expect((await readRow(db, "s-transcribing")).processingStatus).toBe("queued");
    expect((await readRow(db, "s-tidying")).processingStatus).toBe("queued");
    expect((await readRow(db, "s-ready")).processingStatus).toBe("ready");
    expect((await readRow(db, "s-failed")).processingStatus).toBe("failed");
  });
});

describe("listActiveVoiceCaptures", () => {
  it("returns only the user's in-flight and failed captures, oldest first, excluding ready ones", async () => {
    const db = await buildDb();
    await seedVoiceCapture(db, {
      id: "a-queued",
      occurredAt: "2026-07-09T09:03:00.000Z",
      processingStatus: "queued"
    });
    await seedVoiceCapture(db, {
      id: "a-transcribing",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "transcribing"
    });
    await seedVoiceCapture(db, {
      id: "a-failed",
      occurredAt: "2026-07-09T09:02:00.000Z",
      processingStatus: "failed"
    });
    await seedVoiceCapture(db, {
      id: "a-ready",
      occurredAt: "2026-07-09T09:01:00.000Z",
      processingStatus: "ready"
    });
    await seedVoiceCapture(db, {
      id: "a-other",
      occurredAt: "2026-07-09T08:00:00.000Z",
      processingStatus: "queued",
      userId: OTHER_USER_ID
    });

    const active = await listActiveVoiceCaptures(db, DEFAULT_USER_ID);

    expect(active.map((capture) => capture.id)).toEqual(["a-transcribing", "a-failed", "a-queued"]);
  });

  it("returns an empty list when nothing is pending", async () => {
    const db = await buildDb();
    expect(await listActiveVoiceCaptures(db, DEFAULT_USER_ID)).toEqual([]);
  });
});

describe("voice capture routes", () => {
  beforeEach(async () => {
    route = await buildRouteContext();
  });

  afterEach(async () => {
    await route.server.close();
  });

  it("accepts a submission and returns a queued capture id promptly", async () => {
    const accepted = await submit("zh");
    expect(accepted).toEqual({ id: "vc-1", status: "queued" });

    const { code, body } = await getStatus(accepted.id);
    expect(code).toBe(200);
    expect(body).toMatchObject({
      id: "vc-1",
      language: "zh",
      status: "queued",
      text: null,
      failureReason: null
    });
  });

  it("rejects an invalid language", async () => {
    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures?language=fr",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("clip")
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an empty audio body", async () => {
    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures?language=en",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0)
    });
    expect(response.statusCode).toBe(400);
  });

  it("saves-first: a queued capture is out of the Timeline until the worker makes it ready", async () => {
    const accepted = await submit();
    // Save-first before STT: the capture exists but its empty body is kept out of the Timeline.
    expect(await timelineIds()).toEqual([]);

    await processNextVoiceCapture(buildWorker(route.db));

    const { body } = await getStatus(accepted.id);
    expect(body.status).toBe("ready");
    expect(body.text).toBe("the deploy is green");
    expect(await timelineIds()).toEqual([accepted.id]);
    const entriesForUser = await listDiaryEntriesForUser(route.db, DEFAULT_USER_ID);
    expect(entriesForUser).toHaveLength(1);
    expect(entriesForUser[0]?.bodyText).toBe("the deploy is green");
  });

  it("returns 404 for an unknown capture id", async () => {
    const { code } = await getStatus("nope");
    expect(code).toBe(404);
  });

  it("lists active captures for refresh recovery and drops them once ready", async () => {
    const first = await submit("en", "clip-one");
    const second = await submit("zh", "clip-two-longer");

    const beforeReady = await listActive();
    expect(beforeReady.code).toBe(200);
    expect(beforeReady.captures.map((capture) => capture.id)).toEqual([first.id, second.id]);
    expect(beforeReady.captures[0]).toMatchObject({ status: "queued", text: null });

    // Process the oldest (first) capture to ready; it must leave the active list (it is now in the Timeline).
    await processNextVoiceCapture(buildWorker(route.db));

    const afterReady = await listActive();
    expect(afterReady.captures.map((capture) => capture.id)).toEqual([second.id]);
  });

  it("lists a failed capture so the client can offer Retry", async () => {
    await seedVoiceCapture(route.db, {
      id: "listed-fail",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed"
    });

    const { captures } = await listActive();
    expect(captures.map((capture) => capture.id)).toContain("listed-fail");
    expect(captures.find((capture) => capture.id === "listed-fail")?.status).toBe("failed");
  });

  it("shows the body text for a ready capture", async () => {
    await seedVoiceCapture(route.db, {
      id: "ready-raw",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "ready",
      bodyText: "the tidied body"
    });

    const { code, body } = await getStatus("ready-raw");

    expect(code).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.text).toBe("the tidied body");
  });

  it("does not expose another user's capture", async () => {
    await seedVoiceCapture(route.db, {
      id: "other-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      userId: OTHER_USER_ID
    });
    const { code } = await getStatus("other-cap");
    expect(code).toBe(404);
  });

  it("exposes a failed capture's reason", async () => {
    await seedVoiceCapture(route.db, {
      id: "failed-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-x"
    });
    await processNextVoiceCapture(buildWorker(route.db, { speech: throwingSpeech }));

    const { body } = await getStatus("failed-cap");
    expect(body.status).toBe("failed");
    expect(body.failureReason).toBe("whisper crashed");
    expect(body.text).toBeNull();
  });

  it("retries a failed capture back to queued", async () => {
    await seedVoiceCapture(route.db, {
      id: "retry-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed"
    });

    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures/retry-cap/retry"
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as VoiceCaptureStatusDto).status).toBe("queued");
  });

  it("refuses to retry a capture that is not failed", async () => {
    const accepted = await submit();
    const response = await route.server.inject({
      method: "POST",
      url: `/api/diary/voice-captures/${accepted.id}/retry`
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns 404 when retrying an unknown capture", async () => {
    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures/nope/retry"
    });
    expect(response.statusCode).toBe(404);
  });
});
