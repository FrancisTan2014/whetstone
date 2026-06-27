import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Transcription } from "@whetstone/contracts";

import { createFakeCoach } from "../../coach/fakeCoach.js";
import { createLoggerOptions } from "../../config/serverConfig.js";
import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { recallItems, sessionSummaries, turnOutcomes } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { createFakeSpeechInput } from "../../speech/fakeSpeechInput.js";
import { getLearnerProfile } from "../learner/learnerQueries.js";
import { seedCaseCorpus } from "../cases/caseSeed.js";
import { getRecallItemByChunkForUser } from "../recall/recallQueries.js";
import { endSession, startSession, submitTurn, type SessionDependencies } from "./sessionEngine.js";

const userA = "user-a";
const t0 = new Date("2026-01-01T00:00:00.000Z");

let db: DbClient;
let sequence = 0;

function makeDeps(speechTranscript = "scripted speech"): SessionDependencies {
  const scripted: Transcription = { transcript: speechTranscript, words: [] };
  return {
    coach: createFakeCoach(),
    createId: () => `id-${(sequence += 1)}`,
    db,
    now: () => t0,
    speech: createFakeSpeechInput(scripted)
  };
}

async function buildDb(seed = true): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const client = createDbClient(pglite);
  if (seed) {
    await seedCaseCorpus(client);
  }
  return client;
}

beforeEach(async () => {
  sequence = 0;
  db = await buildDb();
});

afterEach(async () => {
  await db.$client.close();
});

describe("startSession", () => {
  it("proposes cues with an English situation and a native target", async () => {
    const plan = await startSession(makeDeps(), userA, t0);

    expect(plan.cues.length).toBeGreaterThan(0);
    expect(plan.cues.length).toBeLessThanOrEqual(5);
    for (const cue of plan.cues) {
      expect(cue.situation.length).toBeGreaterThan(0);
      expect(cue.target.length).toBeGreaterThan(0);
      expect(cue.timerSeconds).toBe(20);
    }
  });

  it("returns no cues when there is nothing to practise", async () => {
    const empty = await buildDb(false);
    try {
      const deps: SessionDependencies = { ...makeDeps(), db: empty };
      expect(await startSession(deps, userA, t0)).toEqual({ cues: [] });
    } finally {
      await empty.$client.close();
    }
  });
});

describe("submitTurn", () => {
  async function firstCue(): Promise<{ chunkId: string; target: string }> {
    const plan = await startSession(makeDeps(), userA, t0);
    const cue = plan.cues[0];
    if (cue === undefined) {
      throw new Error("expected a cue");
    }
    return { chunkId: cue.chunkId, target: cue.target };
  }

  it("grades a perfect typed production, enrolls + schedules the chunk, and deposits the outcome", async () => {
    const { chunkId, target } = await firstCue();
    const deps = makeDeps();

    const outcome = await submitTurn(
      deps,
      { chunkId, production: { kind: "typed", transcript: target } },
      userA,
      t0
    );
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }

    expect(outcome.result.grade).toBe(5);
    expect(outcome.result.errorCategory).toBeNull();
    expect(outcome.result.target).toBe(target);
    expect(outcome.result.transcript).toBe(target);
    expect(new Date(outcome.result.nextDueAt).getTime()).toBeGreaterThan(t0.getTime());

    const item = await getRecallItemByChunkForUser(db, userA, chunkId);
    expect(item).toBeDefined();
    expect(await db.select().from(turnOutcomes).where(eq(turnOutcomes.userId, userA))).toHaveLength(
      1
    );
  });

  it("records a mistake category for a flawed production", async () => {
    const { chunkId } = await firstCue();

    const outcome = await submitTurn(
      makeDeps(),
      { chunkId, production: { kind: "typed", transcript: "something entirely different" } },
      userA,
      t0
    );
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.result.grade).toBeLessThan(3);
    expect(outcome.result.errorCategory).toBe("other");
  });

  it("reuses the existing recall item on a repeat turn", async () => {
    const { chunkId, target } = await firstCue();
    const deps = makeDeps();
    const turn = { chunkId, production: { kind: "typed", transcript: target } } as const;

    await submitTurn(deps, turn, userA, t0);
    await submitTurn(deps, turn, userA, t0);

    const rows = await db.select().from(recallItems).where(eq(recallItems.chunkId, chunkId));
    expect(rows).toHaveLength(1);
  });

  it("transcribes a spoken production through the STT seam", async () => {
    const { chunkId } = await firstCue();
    const deps = makeDeps("help yourself please");

    const outcome = await submitTurn(
      deps,
      { chunkId, production: { audioPath: "/tmp/utterance.wav", kind: "spoken" } },
      userA,
      t0
    );
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.result.transcript).toBe("help yourself please");
  });

  it("returns chunk_not_found for an unknown chunk", async () => {
    const outcome = await submitTurn(
      makeDeps(),
      { chunkId: "nope", production: { kind: "typed", transcript: "x" } },
      userA,
      t0
    );
    expect(outcome).toEqual({ status: "chunk_not_found" });
  });
});

describe("endSession", () => {
  it("aggregates and persists the summary and refreshes the profile", async () => {
    const deps = makeDeps();
    const summary = await endSession(
      deps,
      {
        turns: [
          { errorCategory: null, grade: 5 },
          { errorCategory: "register", grade: 2 }
        ]
      },
      userA,
      t0
    );

    expect(summary).toEqual({
      averageGrade: 3.5,
      errorCounts: [{ category: "register", count: 1 }],
      strongTurns: 1,
      turnCount: 2
    });

    expect(
      await db.select().from(sessionSummaries).where(eq(sessionSummaries.userId, userA))
    ).toHaveLength(1);
    expect(await getLearnerProfile(db, userA)).toBeDefined();
  });
});

describe("session routes", () => {
  function buildServer() {
    return createServer({
      logger: createLoggerOptions("silent"),
      session: makeDeps("spoken words")
    });
  }

  it("runs start -> turn -> end and exposes transcribe over HTTP", async () => {
    const server = buildServer();
    try {
      const startRes = await server.inject({ method: "POST", url: "/api/session/start" });
      expect(startRes.statusCode).toBe(200);
      const plan = startRes.json();
      const chunkId = plan.cues[0].chunkId as string;
      const target = plan.cues[0].target as string;

      const turnRes = await server.inject({
        method: "POST",
        payload: { chunkId, production: { kind: "typed", transcript: target } },
        url: "/api/session/turn"
      });
      expect(turnRes.statusCode).toBe(200);
      expect(turnRes.json().grade).toBe(5);

      const transcribeRes = await server.inject({
        method: "POST",
        payload: { audioPath: "/tmp/a.wav" },
        url: "/api/session/transcribe"
      });
      expect(transcribeRes.statusCode).toBe(200);
      expect(transcribeRes.json().transcript).toBe("spoken words");

      const endRes = await server.inject({
        method: "POST",
        payload: { turns: [{ errorCategory: null, grade: 5 }] },
        url: "/api/session/end"
      });
      expect(endRes.statusCode).toBe(200);
      expect(endRes.json().turnCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid bodies and unknown chunks", async () => {
    const server = buildServer();
    try {
      expect(
        (await server.inject({ method: "POST", payload: {}, url: "/api/session/turn" })).statusCode
      ).toBe(400);
      expect(
        (await server.inject({ method: "POST", payload: {}, url: "/api/session/transcribe" }))
          .statusCode
      ).toBe(400);
      expect(
        (await server.inject({ method: "POST", payload: { turns: "no" }, url: "/api/session/end" }))
          .statusCode
      ).toBe(400);

      const notFound = await server.inject({
        method: "POST",
        payload: { chunkId: "nope", production: { kind: "typed", transcript: "x" } },
        url: "/api/session/turn"
      });
      expect(notFound.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
