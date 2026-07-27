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
  type VoiceCaptureFailureLogger,
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
  logFailure?: VoiceCaptureFailureLogger;
  speech?: SpeechInput;
  speechConfigured?: boolean;
  tidy?: DiaryTidy;
}>;

function buildWorker(
  db: DbClient,
  overrides: WorkerOverrides = {}
): VoiceCaptureWorkerDependencies {
  return {
    db,
    logFailure: overrides.logFailure ?? (() => undefined),
    speech:
      overrides.speech ?? createFakeSpeechInput({ transcript: "the deploy is green", words: [] }),
    // Default to the unconfigured (fake-speech) path, so an empty transcript classifies as
    // `voice_setup_required` unless a test opts into a configured Whisper.
    speechConfigured: overrides.speechConfigured ?? false,
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
      language: row.language === undefined ? null : row.language,
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
let deletedAudioPaths: string[];

async function buildRouteContext(): Promise<RouteContext> {
  const db = await buildDb();
  deletedAudioPaths = [];
  let sequence = 0;
  const diary: DiaryRouteDependencies = {
    createId: () => `vc-${(sequence += 1)}`,
    db,
    deleteAudio: (path) => {
      deletedAudioPaths.push(path);
      return Promise.resolve();
    },
    now: () => new Date("2026-07-09T10:00:00.000Z"),
    saveAudio: (audio) => Promise.resolve(`voice-captures/${audio.length}.audio`)
  };
  return { db, server: createServer({ diary, logger: false }) };
}

async function submit(body = "clip-bytes"): Promise<VoiceCaptureAcceptedDto> {
  const response = await route.server.inject({
    method: "POST",
    url: `/api/diary/voice-captures`,
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

  it("marks a capture failed (transcription_failed) and logs the raw message to safe server logs when transcription throws", async () => {
    await seedVoiceCapture(db, {
      id: "cap-fail",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-keepme"
    });
    const logged: Array<{ captureId: string; category: string; rawMessage: string }> = [];

    const result = await processNextVoiceCapture(
      buildWorker(db, {
        logFailure: (event) => logged.push(event),
        speech: throwingSpeech
      })
    );

    expect(result).toEqual({ status: "failed", id: "cap-fail", code: "transcription_failed" });
    const row = await readRow(db, "cap-fail");
    expect(row.processingStatus).toBe("failed");
    // Only the stable category is persisted — the raw adapter message never touches the DB/API.
    expect(row.failureReason).toBe("transcription_failed");
    expect(row.rawAudioPath).toBe("audio-keepme");
    // …but it IS captured in safe server logs, tagged with the capture id + category.
    expect(logged).toEqual([
      { captureId: "cap-fail", category: "transcription_failed", rawMessage: "whisper crashed" }
    ]);
  });

  it("stringifies a non-Error transcription failure for the safe log and still stores only the category", async () => {
    await seedVoiceCapture(db, {
      id: "cap-str",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const logged: Array<{ captureId: string; category: string; rawMessage: string }> = [];

    const result = await processNextVoiceCapture(
      buildWorker(db, {
        logFailure: (event) => logged.push(event),
        speech: throwingNonErrorSpeech
      })
    );

    expect(result).toEqual({ status: "failed", id: "cap-str", code: "transcription_failed" });
    expect((await readRow(db, "cap-str")).failureReason).toBe("transcription_failed");
    expect(logged[0]?.rawMessage).toBe("stt offline");
  });

  it("persists Whisper's auto-detected language when it is supported (zh/en)", async () => {
    await seedVoiceCapture(db, {
      id: "cap-zh",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      language: null
    });
    const speech = createFakeSpeechInput({
      language: "zh",
      transcript: "the deploy is green",
      words: []
    });

    const result = await processNextVoiceCapture(buildWorker(db, { speech }));

    expect(result).toMatchObject({ status: "processed", id: "cap-zh" });
    expect((await readRow(db, "cap-zh")).language).toBe("zh");
  });

  it("stores a null language when the detected language is unsupported", async () => {
    await seedVoiceCapture(db, {
      id: "cap-fr",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      language: null
    });
    const speech = createFakeSpeechInput({
      language: "fr",
      transcript: "bonjour le monde",
      words: []
    });

    const result = await processNextVoiceCapture(buildWorker(db, { speech }));

    expect(result).toMatchObject({ status: "processed", id: "cap-fr" });
    expect((await readRow(db, "cap-fr")).language).toBeNull();
  });

  it("transcribes a capture using only the audio path and stores a null language when none is detected", async () => {
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
        return Promise.resolve({ language: null, transcript: "the deploy is green", words: [] });
      }
    };

    const result = await processNextVoiceCapture(buildWorker(db, { speech }));

    expect(result).toMatchObject({ status: "processed", id: "cap-nolang" });
    expect(seenAudio).toEqual({ path: "audio-cap-nolang" });
    const row = await readRow(db, "cap-nolang");
    expect(row.processingStatus).toBe("ready");
    expect(row.language).toBeNull();
  });

  it("fails an empty transcript as voice_setup_required when local speech is not configured", async () => {
    await seedVoiceCapture(db, {
      id: "cap-empty",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const speech = createFakeSpeechInput({ transcript: "   ", words: [] });

    const result = await processNextVoiceCapture(
      buildWorker(db, { speech, speechConfigured: false })
    );

    expect(result).toEqual({ status: "failed", id: "cap-empty", code: "voice_setup_required" });
    const row = await readRow(db, "cap-empty");
    expect(row.processingStatus).toBe("failed");
    expect(row.failureReason).toBe("voice_setup_required");
  });

  it("fails an empty transcript as no_speech when local speech IS configured (genuine silence)", async () => {
    await seedVoiceCapture(db, {
      id: "cap-silent",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const speech = createFakeSpeechInput({ transcript: "", words: [] });

    const result = await processNextVoiceCapture(
      buildWorker(db, { speech, speechConfigured: true })
    );

    expect(result).toEqual({ status: "failed", id: "cap-silent", code: "no_speech" });
    expect((await readRow(db, "cap-silent")).failureReason).toBe("no_speech");
  });

  it("fails a capture with no saved audio path as recording_missing", async () => {
    await seedVoiceCapture(db, {
      id: "cap-noaudio",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: null
    });

    const result = await processNextVoiceCapture(buildWorker(db));

    expect(result).toEqual({ status: "failed", id: "cap-noaudio", code: "recording_missing" });
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
    const accepted = await submit();
    expect(accepted).toEqual({ id: "vc-1", status: "queued" });

    const { code, body } = await getStatus(accepted.id);
    expect(code).toBe(200);
    expect(body).toMatchObject({
      id: "vc-1",
      language: null,
      status: "queued",
      text: null,
      failure: null
    });
  });

  it("rejects an empty audio body", async () => {
    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures",
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
    const first = await submit("clip-one");
    const second = await submit("clip-two-longer");

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

  it("exposes a failed capture's stable category (never the raw adapter message)", async () => {
    await seedVoiceCapture(route.db, {
      id: "failed-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-x"
    });
    await processNextVoiceCapture(buildWorker(route.db, { speech: throwingSpeech }));

    const { body } = await getStatus("failed-cap");
    expect(body.status).toBe("failed");
    expect(body.failure).toEqual({ code: "transcription_failed", retryable: true });
    expect(body.text).toBeNull();
  });

  it("maps a legacy free-form failure reason to a safe category at read time (no migration)", async () => {
    await seedVoiceCapture(route.db, {
      id: "legacy-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed"
    });
    // Simulate a row persisted before the category migration: a legacy sentinel value.
    await route.db
      .update(diaryEntries)
      .set({ failureReason: "empty_transcript" })
      .where(eq(diaryEntries.entryId, "legacy-cap"));

    const { body } = await getStatus("legacy-cap");
    expect(body.failure).toEqual({ code: "no_speech", retryable: false });
  });

  it("retries a failed capture back to queued", async () => {
    await seedVoiceCapture(route.db, {
      id: "retry-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed"
    });
    // A retryable failure (transcription failed) — re-queueing from the same audio can succeed.
    await route.db
      .update(diaryEntries)
      .set({ failureReason: "transcription_failed" })
      .where(eq(diaryEntries.entryId, "retry-cap"));

    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures/retry-cap/retry"
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as VoiceCaptureStatusDto).status).toBe("queued");
  });

  it("recovers a retryable transcription_failed capture after wrapper repair: repaired adapter yields the detected language and exactly one diary entry (#780)", async () => {
    await seedVoiceCapture(route.db, {
      id: "stale-fail",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-stale"
    });
    // A stale pre-#647 wrapper makes transcription throw; the capture is kept as retryable
    // transcription_failed (its raw audio is preserved), never a fabricated ready entry.
    const failed = await processNextVoiceCapture(buildWorker(route.db, { speech: throwingSpeech }));
    expect(failed).toMatchObject({ status: "failed", code: "transcription_failed" });
    expect((await readRow(route.db, "stale-fail")).failureReason).toBe("transcription_failed");

    // After `pnpm setup:voice` repairs the wrapper, the learner retries the same saved capture.
    const retry = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures/stale-fail/retry"
    });
    expect(retry.statusCode).toBe(200);

    // The repaired adapter now transcribes and reports Whisper's auto-detected language as metadata.
    const repaired = createFakeSpeechInput({
      language: "zh",
      transcript: "the deploy is green",
      words: []
    });
    const processed = await processNextVoiceCapture(
      buildWorker(route.db, { speech: repaired, speechConfigured: true })
    );
    expect(processed).toMatchObject({ status: "processed", id: "stale-fail" });

    const row = await readRow(route.db, "stale-fail");
    expect(row.processingStatus).toBe("ready");
    expect(row.language).toBe("zh");

    // The same capture completed in place — the Timeline holds exactly one entry, never a duplicate.
    const ids = await timelineIds();
    expect(ids.filter((id) => id === "stale-fail")).toEqual(["stale-fail"]);

    // Retry processed the capture exactly once: a second worker tick finds nothing queued.
    expect(await processNextVoiceCapture(buildWorker(route.db, { speech: repaired }))).toEqual({
      status: "idle"
    });
  });

  it("refuses to retry a non-retryable failure and leaves it failed (no re-queue loop)", async () => {
    await seedVoiceCapture(route.db, {
      id: "no-speech-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed"
    });
    // `no_speech` is non-retryable: re-transcribing the same silent clip can only fail again, so a
    // direct API retry must be refused rather than starting a loop that never succeeds (#675).
    await route.db
      .update(diaryEntries)
      .set({ failureReason: "no_speech" })
      .where(eq(diaryEntries.entryId, "no-speech-cap"));

    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures/no-speech-cap/retry"
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not_retryable" });

    // The row stays failed — it was not re-queued.
    const { body } = await getStatus("no-speech-cap");
    expect(body.status).toBe("failed");
    expect(body.failure).toEqual({ code: "no_speech", retryable: false });
  });

  it("refuses to retry a failed capture with no recorded reason (cannot prove it is retryable)", async () => {
    await seedVoiceCapture(route.db, {
      id: "reasonless-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed"
    });
    // seedVoiceCapture leaves failureReason null; a failed row without a resolvable category is treated
    // as non-retryable so an unknown-cause retry can never spin.
    const response = await route.server.inject({
      method: "POST",
      url: "/api/diary/voice-captures/reasonless-cap/retry"
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not_retryable" });
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

  it("removes a failed capture: deletes its rows and its saved audio, and drops it from the list", async () => {
    await seedVoiceCapture(route.db, {
      id: "remove-cap",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed",
      rawAudioPath: "audio-remove-me"
    });

    const response = await route.server.inject({
      method: "DELETE",
      url: "/api/diary/voice-captures/remove-cap"
    });

    expect(response.statusCode).toBe(204);
    // The audio file is best-effort unlinked…
    expect(deletedAudioPaths).toEqual(["audio-remove-me"]);
    // …and all three Entry facets are gone, so it no longer lists or resolves.
    const { captures } = await listActive();
    expect(captures.map((capture) => capture.id)).not.toContain("remove-cap");
    const [gone] = await route.db
      .select()
      .from(entries)
      .where(eq(entries.id, "remove-cap"))
      .limit(1);
    expect(gone).toBeUndefined();
  });

  it("removes a failed capture with no saved audio without attempting an unlink", async () => {
    await seedVoiceCapture(route.db, {
      id: "remove-noaudio",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed",
      rawAudioPath: null
    });

    const response = await route.server.inject({
      method: "DELETE",
      url: "/api/diary/voice-captures/remove-noaudio"
    });

    expect(response.statusCode).toBe(204);
    expect(deletedAudioPaths).toEqual([]);
  });

  it("refuses to remove a capture that is not failed (409) and keeps its audio", async () => {
    const accepted = await submit();

    const response = await route.server.inject({
      method: "DELETE",
      url: `/api/diary/voice-captures/${accepted.id}`
    });

    expect(response.statusCode).toBe(409);
    expect(deletedAudioPaths).toEqual([]);
    // Still resolvable (not deleted).
    expect((await getStatus(accepted.id)).code).toBe(200);
  });

  it("returns 404 when removing an unknown capture", async () => {
    const response = await route.server.inject({
      method: "DELETE",
      url: "/api/diary/voice-captures/nope"
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not remove another user's failed capture", async () => {
    await seedVoiceCapture(route.db, {
      id: "other-fail",
      occurredAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "failed",
      rawAudioPath: "audio-other",
      userId: OTHER_USER_ID
    });

    const response = await route.server.inject({
      method: "DELETE",
      url: "/api/diary/voice-captures/other-fail"
    });

    expect(response.statusCode).toBe(404);
    expect(deletedAudioPaths).toEqual([]);
    // The other user's row survives.
    const [survivor] = await route.db
      .select()
      .from(entries)
      .where(eq(entries.id, "other-fail"))
      .limit(1);
    expect(survivor).toBeDefined();
  });
});
