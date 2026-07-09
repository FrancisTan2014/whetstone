import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ProposalPayload,
  VoiceCaptureAcceptedDto,
  VoiceCaptureStatusDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, timelineEntries } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { listProposalCandidatesForUser } from "../makeDurable/proposalQueries.js";
import type { ProposalAttempt, ProposalProvider } from "../makeDurable/proposalProvider.js";
import { createFakeSpeechInput } from "../../speech/fakeSpeechInput.js";
import type { SpeechInput } from "../../speech/speechInput.js";
import { listDiaryEntriesForUser } from "./diaryQueries.js";
import type { DiaryTidy } from "./diaryTidy.js";
import type { DiaryRouteDependencies } from "./diaryRoutes.js";
import {
  processNextVoiceCapture,
  requeueStalledVoiceCaptures,
  type VoiceCaptureWorkerDependencies
} from "./voiceCaptureWorker.js";

const OTHER_USER_ID = "user-other";

// A deterministic tidy: drop standalone "um"/"uh" fillers, preserve every other word in order — the
// tidy-not-polish invariant. Used to prove the ready entry's text is the TIDIED transcript.
function fakeTidy(transcript: string): string {
  return transcript
    .split(/\s+/)
    .filter((token) => token.length > 0 && !["um", "uh"].includes(token.toLowerCase()))
    .join(" ");
}

const proposalPayload: ProposalPayload = {
  target: "the deploy is green",
  cue: "a deploy succeeded",
  useContext: "reporting a release",
  category: "work",
  tags: []
};

function proposalAttempt(): ProposalAttempt {
  return {
    modelName: "fake-model",
    generation: {
      candidates: [
        {
          type: "phrase_chunk",
          confidence: 0.9,
          reason: "a reusable status phrase",
          evidenceQuote: "the deploy is green",
          payload: proposalPayload
        }
      ]
    }
  };
}

const proposeNothing: ProposalProvider = () => Promise.resolve(null);
const proposeCandidate: ProposalProvider = () => Promise.resolve(proposalAttempt());

const throwingSpeech: SpeechInput = {
  transcribe: () => Promise.reject(new Error("whisper crashed"))
};

type WorkerOverrides = Readonly<{
  propose?: ProposalProvider;
  speech?: SpeechInput;
  tidy?: DiaryTidy;
}>;

function buildWorker(
  db: DbClient,
  overrides: WorkerOverrides = {}
): VoiceCaptureWorkerDependencies {
  return {
    createId: (() => {
      let sequence = 0;
      return () => `cand-${(sequence += 1)}`;
    })(),
    db,
    propose: overrides.propose ?? proposeNothing,
    proposalTimeoutMs: 50,
    speech:
      overrides.speech ?? createFakeSpeechInput({ transcript: "the deploy is green", words: [] }),
    tidy: overrides.tidy ?? ((transcript) => Promise.resolve(fakeTidy(transcript)))
  };
}

async function seedVoiceCapture(
  db: DbClient,
  row: Readonly<{
    createdAt: string;
    id: string;
    language?: "zh" | "en" | null;
    processingStatus: "queued" | "transcribing" | "tidying" | "ready" | "failed";
    rawAudioPath?: string | null;
    rawInputText?: string;
    tidiedText?: string | null;
    userId?: string;
  }>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: row.id, type: "timeline_entry" });
    await tx.insert(timelineEntries).values({
      entryId: row.id,
      userId: row.userId ?? DEFAULT_USER_ID,
      createdAt: new Date(row.createdAt),
      entryDate: row.createdAt.slice(0, 10),
      inputMode: "voice",
      captureSource: "diary",
      rawInputText: row.rawInputText ?? "",
      tidiedText: row.tidiedText ?? null,
      language: row.language ?? "en",
      rawAudioPath: row.rawAudioPath === undefined ? `audio-${row.id}` : row.rawAudioPath,
      processingStatus: row.processingStatus,
      failureReason: null
    });
  });
}

async function readRow(db: DbClient, id: string) {
  const [row] = await db
    .select()
    .from(timelineEntries)
    .where(eq(timelineEntries.entryId, id))
    .limit(1);
  return row;
}

async function requeueToQueued(db: DbClient, id: string): Promise<void> {
  await db
    .update(timelineEntries)
    .set({ processingStatus: "queued" })
    .where(eq(timelineEntries.entryId, id));
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
    propose: proposeNothing,
    proposalTimeoutMs: 50,
    saveAudio: (audio) => Promise.resolve(`voice-captures/${audio.length}.audio`),
    tidy: (transcript) => Promise.resolve(fakeTidy(transcript))
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

describe("processNextVoiceCapture", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  it("is idle when nothing is queued", async () => {
    expect(await processNextVoiceCapture(buildWorker(db), new Date())).toEqual({ status: "idle" });
  });

  it("transcribes, tidies, and marks a queued capture ready, filling its text", async () => {
    await seedVoiceCapture(db, {
      id: "cap-1",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const speech = createFakeSpeechInput({ transcript: "um the deploy is green", words: [] });

    const result = await processNextVoiceCapture(buildWorker(db, { speech }), new Date());

    expect(result).toEqual({ status: "processed", id: "cap-1", cardCreated: false });
    const row = await readRow(db, "cap-1");
    expect(row.processingStatus).toBe("ready");
    expect(row.rawInputText).toBe("um the deploy is green");
    expect(row.tidiedText).toBe("the deploy is green");
    expect(row.failureReason).toBeNull();
  });

  it("selects the oldest queued capture first", async () => {
    await seedVoiceCapture(db, {
      id: "newer",
      createdAt: "2026-07-09T09:05:00.000Z",
      processingStatus: "queued"
    });
    await seedVoiceCapture(db, {
      id: "older",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });

    const result = await processNextVoiceCapture(buildWorker(db), new Date());

    expect(result).toMatchObject({ status: "processed", id: "older" });
    expect((await readRow(db, "newer")).processingStatus).toBe("queued");
  });

  it("runs the Make Durable gate on the ready capture and reports a created card", async () => {
    await seedVoiceCapture(db, {
      id: "cap-card",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });

    const result = await processNextVoiceCapture(
      buildWorker(db, { propose: proposeCandidate }),
      new Date()
    );

    expect(result).toEqual({ status: "processed", id: "cap-card", cardCreated: true });
    expect(await listProposalCandidatesForUser(db, DEFAULT_USER_ID)).toHaveLength(1);
  });

  it("marks a capture failed and keeps its audio when transcription throws", async () => {
    await seedVoiceCapture(db, {
      id: "cap-fail",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-keepme"
    });

    const result = await processNextVoiceCapture(
      buildWorker(db, { speech: throwingSpeech }),
      new Date()
    );

    expect(result).toEqual({ status: "failed", id: "cap-fail", reason: "whisper crashed" });
    const row = await readRow(db, "cap-fail");
    expect(row.processingStatus).toBe("failed");
    expect(row.failureReason).toBe("whisper crashed");
    expect(row.rawAudioPath).toBe("audio-keepme");
  });

  it("fails a capture whose transcript is empty rather than persisting a hollow ready entry", async () => {
    await seedVoiceCapture(db, {
      id: "cap-empty",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const speech = createFakeSpeechInput({ transcript: "   ", words: [] });

    const result = await processNextVoiceCapture(buildWorker(db, { speech }), new Date());

    expect(result).toEqual({ status: "failed", id: "cap-empty", reason: "empty_transcript" });
    expect((await readRow(db, "cap-empty")).processingStatus).toBe("failed");
  });

  it("fails a capture with no saved audio path", async () => {
    await seedVoiceCapture(db, {
      id: "cap-noaudio",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: null
    });

    const result = await processNextVoiceCapture(buildWorker(db), new Date());

    expect(result).toEqual({ status: "failed", id: "cap-noaudio", reason: "missing_audio" });
  });

  it("does not create a duplicate proposal candidate when a capture is reprocessed", async () => {
    await seedVoiceCapture(db, {
      id: "cap-dup",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued"
    });
    const worker = buildWorker(db, { propose: proposeCandidate });

    await processNextVoiceCapture(worker, new Date());
    // Force a re-run of the same (now ready) capture; the guard must skip a second proposal.
    await requeueToQueued(db, "cap-dup");
    const second = await processNextVoiceCapture(worker, new Date());

    expect(second).toEqual({ status: "processed", id: "cap-dup", cardCreated: false });
    expect(await listProposalCandidatesForUser(db, DEFAULT_USER_ID)).toHaveLength(1);
  });
});

describe("requeueStalledVoiceCaptures", () => {
  it("requeues only in-flight captures a dead worker left behind", async () => {
    const db = await buildDb();
    await seedVoiceCapture(db, {
      id: "s-transcribing",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "transcribing"
    });
    await seedVoiceCapture(db, {
      id: "s-tidying",
      createdAt: "2026-07-09T09:01:00.000Z",
      processingStatus: "tidying"
    });
    await seedVoiceCapture(db, {
      id: "s-ready",
      createdAt: "2026-07-09T09:02:00.000Z",
      processingStatus: "ready"
    });
    await seedVoiceCapture(db, {
      id: "s-failed",
      createdAt: "2026-07-09T09:03:00.000Z",
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

  it("keeps a pending capture out of the Timeline until it is ready", async () => {
    const accepted = await submit();
    expect(await listDiaryEntriesForUser(route.db, DEFAULT_USER_ID)).toHaveLength(0);

    await processNextVoiceCapture(buildWorker(route.db), new Date());

    const { body } = await getStatus(accepted.id);
    expect(body.status).toBe("ready");
    expect(body.text).toBe("the deploy is green");
    const entriesForUser = await listDiaryEntriesForUser(route.db, DEFAULT_USER_ID);
    expect(entriesForUser).toHaveLength(1);
    expect(entriesForUser[0]?.text).toBe("the deploy is green");
  });

  it("returns 404 for an unknown capture id", async () => {
    const { code } = await getStatus("nope");
    expect(code).toBe(404);
  });

  it("does not expose another user's capture", async () => {
    await seedVoiceCapture(route.db, {
      id: "other-cap",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      userId: OTHER_USER_ID
    });
    const { code } = await getStatus("other-cap");
    expect(code).toBe(404);
  });

  it("exposes a failed capture's reason", async () => {
    await seedVoiceCapture(route.db, {
      id: "failed-cap",
      createdAt: "2026-07-09T09:00:00.000Z",
      processingStatus: "queued",
      rawAudioPath: "audio-x"
    });
    await processNextVoiceCapture(buildWorker(route.db, { speech: throwingSpeech }), new Date());

    const { body } = await getStatus("failed-cap");
    expect(body.status).toBe("failed");
    expect(body.failureReason).toBe("whisper crashed");
    expect(body.text).toBeNull();
  });

  it("retries a failed capture back to queued", async () => {
    await seedVoiceCapture(route.db, {
      id: "retry-cap",
      createdAt: "2026-07-09T09:00:00.000Z",
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
