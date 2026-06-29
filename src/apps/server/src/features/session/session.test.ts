import { PGlite } from "@electric-sql/pglite";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CoachKnobs, Transcription } from "@whetstone/contracts";

import { createFakeCoach } from "../../coach/fakeCoach.js";
import { createLoggerOptions } from "../../config/serverConfig.js";
import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { errorPatterns, recallItems, sessionExchanges, turnOutcomes } from "../../db/schema.js";
import { entries, noteAnchors, notes, noteTemplates } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { createFakeSpeechInput } from "../../speech/fakeSpeechInput.js";
import { depositTurnOutcome } from "../learner/learnerCommands.js";
import { getLearnerProfile } from "../learner/learnerQueries.js";
import { compileProgressMap } from "../map/mapQueries.js";
import { seedCaseCorpus } from "../cases/caseSeed.js";
import {
  getRecallItemByChunkForUser,
  getRecallItemByTextForUser
} from "../recall/recallQueries.js";
import {
  converseTurn,
  endSession,
  startSession,
  submitTurn,
  type SessionDependencies
} from "./sessionEngine.js";

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
    saveAudio: () => Promise.resolve("/tmp/saved.audio"),
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

// Seed a reading capture for userA: a block entry, a note + its template, and the selected-text anchor,
// so the harvest on-ramp (#243) has a recent capture to seed a case from.
async function seedCapture(
  selectedText: string,
  blockId: string,
  noteId = "note-1",
  createdAt: Date = t0
): Promise<void> {
  await db.insert(entries).values([
    { id: blockId, type: "block" },
    { id: noteId, type: "note" }
  ]);
  await db
    .insert(noteTemplates)
    .values({ fieldsJson: [], id: "vocab", name: "Vocab", orderIndex: 0 })
    .onConflictDoNothing();
  await db.insert(notes).values({
    answersJson: {},
    createdAt,
    entryId: noteId,
    markdownBody: "x",
    templateId: "vocab",
    userId: userA
  });
  await db.insert(noteAnchors).values({
    blockEntryId: blockId,
    contextSnapshot: "from the book",
    endBlockEntryId: blockId,
    noteEntryId: noteId,
    selectedText
  });
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

  it("seeds the first cue from a recent reading capture, targeting the captured text (#243)", async () => {
    await seedCapture("thrive under pressure", "blk-1");

    const plan = await startSession(makeDeps(), userA, t0);

    expect(plan.cues[0]?.target).toBe("thrive under pressure");
    expect(plan.cues[0]?.chunkId).toContain("harvest-chunk-");
  });

  it("seeds from the newest capture by time, even when its id sorts earlier (#243)", async () => {
    // "aaa" sorts before "zzz" lexicographically, but is the newer capture by createdAt.
    await seedCapture("older phrase", "blk-old", "zzz-old", new Date("2026-01-01T00:00:00Z"));
    await seedCapture("newer phrase", "blk-new", "aaa-new", new Date("2026-02-01T00:00:00Z"));

    const plan = await startSession(makeDeps(), userA, t0);
    expect(plan.cues[0]?.target).toBe("newer phrase");
  });
  it("does not harvest a case when there are no domains to attach it to", async () => {
    const empty = await buildDb(false);
    const previous = db;
    db = empty;
    try {
      await seedCapture("thrive under pressure", "blk-1");
      const deps: SessionDependencies = { ...makeDeps(), db: empty };
      expect(await startSession(deps, userA, t0)).toEqual({ cues: [] });
    } finally {
      db = previous;
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

  it("links a harvested round's deposit back to the source block (#243)", async () => {
    await seedCapture("thrive under pressure", "blk-1");
    const plan = await startSession(makeDeps(), userA, t0);
    const cue = plan.cues[0];
    if (cue === undefined) {
      throw new Error("expected a harvested cue");
    }

    const outcome = await submitTurn(
      makeDeps(),
      { chunkId: cue.chunkId, transcript: cue.target },
      userA,
      t0
    );
    expect(outcome.status).toBe("ok");

    const items = await db.select().from(recallItems).where(eq(recallItems.chunkId, cue.chunkId));
    expect(items[0]?.provenanceEntryId).toBe("blk-1");
  });

  it("grades a perfect typed production, enrolls + schedules the chunk, and deposits the outcome", async () => {
    const { chunkId, target } = await firstCue();
    const deps = makeDeps();

    const outcome = await submitTurn(deps, { chunkId, transcript: target }, userA, t0);
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
      { chunkId, transcript: "something entirely different" },
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
    const turn = { chunkId, transcript: target } as const;

    await submitTurn(deps, turn, userA, t0);
    await submitTurn(deps, turn, userA, t0);

    const rows = await db.select().from(recallItems).where(eq(recallItems.chunkId, chunkId));
    expect(rows).toHaveLength(1);
  });

  it("returns chunk_not_found for an unknown chunk", async () => {
    const outcome = await submitTurn(makeDeps(), { chunkId: "nope", transcript: "x" }, userA, t0);
    expect(outcome).toEqual({ status: "chunk_not_found" });
  });
});

describe("converseTurn", () => {
  async function firstCaseId(): Promise<string> {
    const plan = await startSession(makeDeps(), userA, t0);
    const cue = plan.cues[0];
    if (cue === undefined) {
      throw new Error("expected a cue");
    }
    return cue.caseId;
  }

  it("replies in flow with no repair on a normal turn and persists the exchange", async () => {
    const caseId = await firstCaseId();
    const deps = makeDeps();

    const outcome = await converseTurn(deps, { caseId, transcript: "Help yourself." }, userA, t0);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }

    expect(outcome.reply.say.length).toBeGreaterThan(0);
    expect(outcome.reply.repair).toBeUndefined();

    const rows = await db
      .select()
      .from(sessionExchanges)
      .where(eq(sessionExchanges.userId, userA))
      .orderBy(asc(sessionExchanges.orderIndex));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ orderIndex: 0, role: "user", text: "Help yourself." });
    expect(rows[1]).toMatchObject({ orderIndex: 1, role: "coach", text: outcome.reply.say });
    expect(rows[1]?.repairJson).toBeNull();
    // The user turn's English share is recorded (all-English -> 1); coach turns carry none.
    expect(rows[0]?.englishShare).toBe(1);
    expect(rows[1]?.englishShare).toBeNull();
  });

  it("records the user turn's English share so the bilingual trend can be read (#270)", async () => {
    const caseId = await firstCaseId();

    await converseTurn(makeDeps(), { caseId, transcript: "我想点 some rice" }, userA, t0);

    const userRow = (
      await db.select().from(sessionExchanges).where(eq(sessionExchanges.role, "user"))
    )[0];
    // "some rice" = 8 Latin letters; "我想点" = 3 CJK characters -> 8 / 11.
    expect(userRow?.englishShare).toBeCloseTo(8 / 11);
  });

  it("opens the bilingual dial on the first mostly-Chinese turn from a fresh user (#270)", async () => {
    const caseId = await firstCaseId();
    const fake = createFakeCoach();
    let firstKnobs: { l1: string; targetL1Share: number } | undefined;
    const deps: SessionDependencies = {
      ...makeDeps(),
      coach: {
        ...fake,
        converse: (request) => {
          firstKnobs ??= { l1: request.knobs.l1, targetL1Share: request.knobs.targetL1Share };
          return fake.converse(request);
        }
      }
    };

    // A fresh user with no prior exchanges opens with a mostly-Chinese turn. The current turn's mix is
    // folded into the knobs for THIS same call, so the coach opens the bilingual dial immediately
    // (l1 zh, positive target L1 share, one English chunk to retry) -- not only on the next round.
    const first = await converseTurn(deps, { caseId, transcript: "我想点菜 please" }, userA, t0);
    if (first.status !== "ok") {
      throw new Error("expected ok");
    }

    expect(firstKnobs?.l1).toBe("zh");
    expect(firstKnobs?.targetL1Share).toBeGreaterThan(0);
    expect(first.reply.englishTarget?.length).toBeGreaterThan(0);
  });

  it("keeps the bilingual dial open on a later English turn once the trend shows L1 (#270)", async () => {
    const caseId = await firstCaseId();
    const fake = createFakeCoach();
    let lastKnobs: { l1: string; targetL1Share: number } | undefined;
    const deps: SessionDependencies = {
      ...makeDeps(),
      coach: {
        ...fake,
        converse: (request) => {
          lastKnobs = { l1: request.knobs.l1, targetL1Share: request.knobs.targetL1Share };
          return fake.converse(request);
        }
      }
    };

    // A mostly-Chinese turn persists a low English share...
    await converseTurn(deps, { caseId, transcript: "我想点菜 please" }, userA, t0);

    // ...so even a fully-English next turn keeps the dial open: the persisted trend still infers L1 zh
    // and a positive target L1 share for the user who has been leaning on Chinese.
    const second = await converseTurn(
      deps,
      { caseId, transcript: "I would like to order" },
      userA,
      new Date(t0.getTime() + 60_000)
    );
    if (second.status !== "ok") {
      throw new Error("expected ok");
    }

    expect(lastKnobs?.l1).toBe("zh");
    expect(lastKnobs?.targetL1Share).toBeGreaterThan(0);
    expect(second.reply.englishTarget?.length).toBeGreaterThan(0);
  });

  it("offers light repair and persists it when the learner breaks down (empty transcript)", async () => {
    const caseId = await firstCaseId();

    const outcome = await converseTurn(makeDeps(), { caseId, transcript: "" }, userA, t0);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.reply.repair).toBeDefined();

    const coachRow = (
      await db.select().from(sessionExchanges).where(eq(sessionExchanges.role, "coach"))
    )[0];
    expect(coachRow?.repairJson).toEqual(outcome.reply.repair);
  });

  it("rebuilds the conversation across turns, advancing the coach reply", async () => {
    const caseId = await firstCaseId();
    const deps = makeDeps();

    const first = await converseTurn(deps, { caseId, transcript: "Help yourself." }, userA, t0);
    const second = await converseTurn(deps, { caseId, transcript: "Have some more." }, userA, t0);
    if (first.status !== "ok" || second.status !== "ok") {
      throw new Error("expected ok");
    }

    // The opening reply differs from the in-conversation follow-up — proof history was reconstructed.
    expect(second.reply.say).not.toBe(first.reply.say);
    expect(
      await db.select().from(sessionExchanges).where(eq(sessionExchanges.userId, userA))
    ).toHaveLength(4);
  });

  it("returns case_not_found for an unknown case and persists nothing", async () => {
    const outcome = await converseTurn(makeDeps(), { caseId: "nope", transcript: "x" }, userA, t0);
    expect(outcome).toEqual({ status: "case_not_found" });
    expect(await db.select().from(sessionExchanges)).toHaveLength(0);
  });
});

describe("endSession", () => {
  it("links a harvested chunk's end-of-round deposit to the source block (#243)", async () => {
    await seedCapture("thrive under pressure", "blk-1");
    const deps = makeDeps();
    const plan = await startSession(deps, userA, t0);
    const cue = plan.cues[0];
    if (cue === undefined) {
      throw new Error("expected a harvested cue");
    }

    await converseTurn(deps, { caseId: cue.caseId, transcript: cue.target }, userA, t0);
    expect((await endSession(deps, { caseId: cue.caseId, words: [] }, userA, t0)).status).toBe(
      "ok"
    );

    const items = await db.select().from(recallItems).where(eq(recallItems.chunkId, cue.chunkId));
    expect(items[0]?.provenanceEntryId).toBe("blk-1");
  });

  it("runs one analysis pass and moves all four deposits, returning the debrief", async () => {
    const deps = makeDeps();
    const plan = await startSession(deps, userA, t0);
    const cue = plan.cues[0];
    if (cue === undefined) {
      throw new Error("expected a cue");
    }

    // The learner produced one chunk's target in the conversation; the rest go ungraded.
    await converseTurn(deps, { caseId: cue.caseId, transcript: cue.target }, userA, t0);

    const beforeMap = await compileProgressMap(db, userA, t0);
    const beforeCase = beforeMap.domains
      .flatMap((domain) => domain.cases)
      .find((mapCase) => mapCase.caseId === cue.caseId);

    const outcome = await endSession(deps, { caseId: cue.caseId, words: [] }, userA, t0);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }

    // The debrief reads from the analysis.
    expect(outcome.debrief.encouragement.length).toBeGreaterThan(0);
    expect(outcome.debrief.due.length).toBeGreaterThan(0);
    expect(outcome.debrief.upgrade.native.length).toBeGreaterThan(0);

    // Deposit 1: the produced chunk has a recall item scheduled.
    expect(await getRecallItemByChunkForUser(db, userA, cue.chunkId)).toBeDefined();
    expect(
      (await db.select().from(recallItems).where(eq(recallItems.userId, userA))).length
    ).toBeGreaterThan(0);

    // Deposit 2: tagged mistakes incremented the error-pattern store.
    expect(
      (await db.select().from(errorPatterns).where(eq(errorPatterns.userId, userA))).length
    ).toBeGreaterThan(0);

    // Deposit 3: the rolling profile was refreshed.
    expect(await getLearnerProfile(db, userA)).toBeDefined();

    // Deposit 4: case mastery advanced — the map shows fewer "new" chunks than before.
    const afterMap = await compileProgressMap(db, userA, t0);
    const afterCase = afterMap.domains
      .flatMap((domain) => domain.cases)
      .find((mapCase) => mapCase.caseId === cue.caseId);
    expect(afterCase?.mastery.newChunks).toBeLessThan(beforeCase?.mastery.newChunks ?? 0);
  });

  it("deposits the bilingual coach's pushed English target as recall practice, deduped (#270)", async () => {
    const deps = makeDeps();
    const plan = await startSession(deps, userA, t0);
    const caseId = plan.cues[0]?.caseId;
    if (caseId === undefined) {
      throw new Error("expected a cue");
    }

    // Two mostly-Chinese turns each earn the same pushed English target ("Let's try that in
    // English." from the fake coach), so the round-end deposit must dedupe to a single recall item.
    await converseTurn(deps, { caseId, transcript: "我想点菜 please" }, userA, t0);
    await converseTurn(
      deps,
      { caseId, transcript: "再来一个 thanks" },
      userA,
      new Date(t0.getTime() + 30_000)
    );

    const outcome = await endSession(
      deps,
      { caseId, words: [] },
      userA,
      new Date(t0.getTime() + 60_000)
    );
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }

    // The pushed target is now durable recall material: an LLM-supplied phrase with no chunk FK,
    // surfaced as due practice in the debrief.
    const item = await getRecallItemByTextForUser(db, userA, "Let's try that in English.");
    expect(item?.kind).toBe("phrase");
    expect(item?.chunkId).toBeNull();
    expect(outcome.debrief.due.some((entry) => entry.text === "Let's try that in English.")).toBe(
      true
    );
    // Deduped within the round despite two pushes.
    const phrases = await db
      .select()
      .from(recallItems)
      .where(
        and(eq(recallItems.userId, userA), eq(recallItems.text, "Let's try that in English."))
      );
    expect(phrases).toHaveLength(1);
  });

  it("does not re-deposit a pushed English target already enrolled from an earlier round (#270)", async () => {
    const deps = makeDeps();
    const plan = await startSession(deps, userA, t0);
    const caseId = plan.cues[0]?.caseId;
    if (caseId === undefined) {
      throw new Error("expected a cue");
    }

    await converseTurn(deps, { caseId, transcript: "我想点菜 please" }, userA, t0);
    await endSession(deps, { caseId, words: [] }, userA, new Date(t0.getTime() + 60_000));

    // A later round pushes the same target again...
    await converseTurn(
      deps,
      { caseId, transcript: "我想点菜 again please" },
      userA,
      new Date(t0.getTime() + 120_000)
    );
    const second = await endSession(
      deps,
      { caseId, words: [] },
      userA,
      new Date(t0.getTime() + 180_000)
    );
    if (second.status !== "ok") {
      throw new Error("expected ok");
    }

    // ...so the existing recall item is reused, not duplicated, and the debrief does not re-surface it.
    const phrases = await db
      .select()
      .from(recallItems)
      .where(
        and(eq(recallItems.userId, userA), eq(recallItems.text, "Let's try that in English."))
      );
    expect(phrases).toHaveLength(1);
    expect(second.debrief.due.some((entry) => entry.text === "Let's try that in English.")).toBe(
      false
    );
  });

  it("returns case_not_found for an unknown case", async () => {
    const outcome = await endSession(makeDeps(), { caseId: "nope", words: [] }, userA, t0);
    expect(outcome).toEqual({ status: "case_not_found" });
  });

  it("ignores a grade for a chunk outside the round rather than enrolling a dangling item", async () => {
    const plan = await startSession(makeDeps(), userA, t0);
    const caseId = plan.cues[0]?.caseId;
    if (caseId === undefined) {
      throw new Error("expected a cue");
    }

    const deps: SessionDependencies = {
      ...makeDeps(),
      coach: {
        ...createFakeCoach(),
        analyze: () =>
          Promise.resolve({
            chunkGrades: [{ chunkId: "ghost-chunk", grade: 5 }],
            encouragement: "Solid.",
            mistakes: [],
            upgrade: { native: "n", said: "s" },
            wins: []
          })
      }
    };

    const outcome = await endSession(deps, { caseId, words: [] }, userA, t0);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.debrief.due).toEqual([]);
    expect(await db.select().from(recallItems).where(eq(recallItems.userId, userA))).toHaveLength(
      0
    );
  });
});

describe("adaptive coach knobs (#223)", () => {
  // Capture the knobs the engine briefs the coach with, while delegating to the real fake.
  function spyingDeps(): { captured: CoachKnobs[]; deps: SessionDependencies } {
    const captured: CoachKnobs[] = [];
    const fake = createFakeCoach();
    const deps: SessionDependencies = {
      ...makeDeps(),
      coach: {
        ...fake,
        converse: (request) => {
          captured.push(request.knobs);
          return fake.converse(request);
        }
      }
    };
    return { captured, deps };
  }

  function lastKnobs(captured: CoachKnobs[]): CoachKnobs {
    const knobs = captured[captured.length - 1];
    if (knobs === undefined) {
      throw new Error("expected knobs to have been captured");
    }
    return knobs;
  }

  it("targets a recurring error pattern in the learner model on the round's knobs", async () => {
    const { captured, deps } = spyingDeps();
    const plan = await startSession(deps, userA, t0);
    const caseId = plan.cues[0]?.caseId;
    if (caseId === undefined) {
      throw new Error("expected a cue");
    }

    // Baseline: a fresh model probes nothing and has no profile-derived focus yet.
    await converseTurn(deps, { caseId, transcript: "hello" }, userA, t0);
    expect(lastKnobs(captured).probeErrorPatterns).toEqual([]);
    expect(lastKnobs(captured).focus).toBe("");

    // Deposit a recurring error into the learner model, then the next round's knobs target it.
    await depositTurnOutcome(
      { createId: deps.createId, db },
      { chunkId: null, errorCategory: "article_drop", grade: 2 },
      userA,
      t0
    );

    await converseTurn(deps, { caseId, transcript: "hello again" }, userA, t0);
    expect(lastKnobs(captured).probeErrorPatterns).toContain("article_drop");

    // After a round ends and the rolling profile is written, the knobs' focus comes from the model.
    await endSession(deps, { caseId, words: [] }, userA, t0);
    await converseTurn(deps, { caseId, transcript: "and more" }, userA, t0);
    expect(lastKnobs(captured).focus.length).toBeGreaterThan(0);
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
        payload: { chunkId, transcript: target },
        url: "/api/session/turn"
      });
      expect(turnRes.statusCode).toBe(200);
      expect(turnRes.json().grade).toBe(5);

      const transcribeRes = await server.inject({
        headers: { "content-type": "application/octet-stream" },
        method: "POST",
        payload: Buffer.from("fake-audio-bytes"),
        url: "/api/session/transcribe"
      });
      expect(transcribeRes.statusCode).toBe(200);
      expect(transcribeRes.json().transcript).toBe("spoken words");

      const caseId = plan.cues[0].caseId as string;
      const endRes = await server.inject({
        method: "POST",
        payload: { caseId, words: [] },
        url: "/api/session/end"
      });
      expect(endRes.statusCode).toBe(200);
      expect((endRes.json().encouragement as string).length).toBeGreaterThan(0);

      const endNotFound = await server.inject({
        method: "POST",
        payload: { caseId: "nope", words: [] },
        url: "/api/session/end"
      });
      expect(endNotFound.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("holds a conversational coach turn over /api/session/say", async () => {
    const server = buildServer();
    try {
      const startRes = await server.inject({ method: "POST", url: "/api/session/start" });
      const caseId = startRes.json().cues[0].caseId as string;

      const sayRes = await server.inject({
        method: "POST",
        payload: { caseId, transcript: "Help yourself to some rice." },
        url: "/api/session/say"
      });
      expect(sayRes.statusCode).toBe(200);
      expect((sayRes.json().say as string).length).toBeGreaterThan(0);

      const invalid = await server.inject({
        method: "POST",
        payload: {},
        url: "/api/session/say"
      });
      expect(invalid.statusCode).toBe(400);

      const notFound = await server.inject({
        method: "POST",
        payload: { caseId: "nope", transcript: "x" },
        url: "/api/session/say"
      });
      expect(notFound.statusCode).toBe(404);
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
        (
          await server.inject({
            headers: { "content-type": "application/octet-stream" },
            method: "POST",
            payload: Buffer.alloc(0),
            url: "/api/session/transcribe"
          })
        ).statusCode
      ).toBe(400);
      expect(
        (await server.inject({ method: "POST", payload: {}, url: "/api/session/end" })).statusCode
      ).toBe(400);

      const notFound = await server.inject({
        method: "POST",
        payload: { chunkId: "nope", transcript: "x" },
        url: "/api/session/turn"
      });
      expect(notFound.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
