import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseNudgeResponse, type NudgeDto } from "@whetstone/contracts";

import { createFakeCoach } from "../../coach/fakeCoach.js";
import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  blocks,
  entries,
  noteAnchors,
  notes,
  nudgeState,
  readingUnits,
  workMeta
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { createFakeSpeechInput } from "../../speech/fakeSpeechInput.js";
import { seedCaseCorpus } from "../cases/caseSeed.js";
import { startSession, submitTurn, type SessionDependencies } from "../session/sessionEngine.js";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const baseNow = new Date("2026-03-01T00:00:00.000Z");

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
  session: SessionDependencies;
  setNow: (when: Date) => void;
}>;

let context: TestContext;
let sequence = 0;

async function buildContext(seedCorpus = true): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  if (seedCorpus) {
    await seedCaseCorpus(db);
  }

  let now = baseNow;
  const session: SessionDependencies = {
    coach: createFakeCoach(),
    createId: () => `id-${(sequence += 1)}`,
    db,
    now: () => now,
    saveAudio: () => Promise.resolve("/tmp/saved.audio"),
    speech: createFakeSpeechInput({ transcript: "scripted", words: [] })
  };

  return {
    db,
    server: createServer({ logger: false, nudge: { db, now: () => now }, session }),
    session,
    setNow: (when) => {
      now = when;
    }
  };
}

// Seed a single shared work + reading unit so captures resolve a work title via the block join.
async function seedWork(): Promise<void> {
  await context.db.insert(authors).values({ id: "author-1", name: "A. Writer" });
  await context.db.insert(entries).values([
    { id: "work-1", type: "work" },
    { id: "unit-1", type: "reading_unit" }
  ]);
  await context.db.insert(workMeta).values({
    authorId: "author-1",
    entryId: "work-1",
    language: "en",
    title: "On Grit",
    workType: "essay"
  });
  await context.db
    .insert(readingUnits)
    .values({ entryId: "unit-1", orderIndex: 0, title: "Unit", workEntryId: "work-1" });
}

// Seed a reading capture (a block in the shared work, a note, and its selected-text anchor).
async function seedCapture(
  noteId: string,
  blockId: string,
  selectedText: string,
  capturedAt: Date
): Promise<{ caseId: string; chunkId: string; target: string }> {
  await context.db.insert(entries).values([
    { id: blockId, type: "block" },
    { id: noteId, type: "note" }
  ]);
  await context.db.insert(blocks).values({
    blockType: "paragraph",
    entryId: blockId,
    mdastJson: {},
    orderIndex: 0,
    plaintext: selectedText,
    readingUnitEntryId: "unit-1",
    workEntryId: "work-1"
  });
  await context.db.insert(notes).values({
    answersJson: {},
    createdAt: capturedAt,
    entryId: noteId,
    markdownBody: "x",
    templateId: null,
    userId: DEFAULT_USER_ID
  });
  await context.db.insert(noteAnchors).values({
    blockEntryId: blockId,
    contextSnapshot: "from the essay",
    endBlockEntryId: blockId,
    noteEntryId: noteId,
    selectedText
  });

  return { caseId: `harvest-${noteId}`, chunkId: `harvest-chunk-${noteId}`, target: selectedText };
}

async function getNudge(): Promise<NudgeDto | null> {
  const response = await context.server.inject({ method: "GET", url: "/api/nudge" });
  expect(response.statusCode).toBe(200);
  return parseNudgeResponse(response.json()).nudge;
}

async function dismiss(chunkId: string): Promise<number> {
  const response = await context.server.inject({
    method: "POST",
    url: `/api/nudge/${encodeURIComponent(chunkId)}/dismiss`
  });
  return response.statusCode;
}

beforeEach(async () => {
  sequence = 0;
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("GET /api/nudge", () => {
  it("surfaces the top-ranked recent capture as a NudgeDto with its work title and source block", async () => {
    await seedWork();
    await seedCapture("note-old", "blk-old", "older phrase", new Date("2026-01-15T00:00:00Z"));
    const newer = await seedCapture(
      "note-new",
      "blk-new",
      "thrive under pressure",
      new Date("2026-02-15T00:00:00Z")
    );

    const nudge = await getNudge();

    expect(nudge).toEqual({
      blockEntryId: "blk-new",
      caseId: newer.caseId,
      chunkId: newer.chunkId,
      text: "thrive under pressure",
      workTitle: "On Grit"
    });
  });

  it("returns null at cold start (no captures)", async () => {
    expect(await getNudge()).toBeNull();
  });

  it("records that the surfaced chunk was shown", async () => {
    await seedWork();
    const capture = await seedCapture("note-1", "blk-1", "hello", new Date("2026-02-01T00:00:00Z"));

    await getNudge();

    const [row] = await context.db
      .select()
      .from(nudgeState)
      .where(and(eq(nudgeState.userId, DEFAULT_USER_ID), eq(nudgeState.chunkId, capture.chunkId)));
    expect(row?.lastSurfacedAt?.toISOString()).toBe(baseNow.toISOString());
    expect(row?.dismissedUntil).toBeNull();
  });
});

describe("POST /api/nudge/:chunkId/dismiss", () => {
  it("puts the chunk in cooldown so it stops surfacing, then surfaces again once it lapses", async () => {
    await seedWork();
    const capture = await seedCapture("note-1", "blk-1", "hello", new Date("2026-02-01T00:00:00Z"));

    expect((await getNudge())?.chunkId).toBe(capture.chunkId);
    expect(await dismiss(capture.chunkId)).toBe(204);

    // Within the cooldown window, the chunk no longer surfaces.
    expect(await getNudge()).toBeNull();

    // After the cooldown lapses, it can surface again.
    context.setNow(new Date(baseNow.getTime() + 4 * day));
    expect((await getNudge())?.chunkId).toBe(capture.chunkId);
  });

  it("persists the cooldown as user-owned state and dismiss is idempotent", async () => {
    await seedWork();
    const capture = await seedCapture("note-1", "blk-1", "hello", new Date("2026-02-01T00:00:00Z"));

    await dismiss(capture.chunkId);
    await dismiss(capture.chunkId);

    const rows = await context.db
      .select()
      .from(nudgeState)
      .where(eq(nudgeState.userId, DEFAULT_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dismissedUntil?.toISOString()).toBe(
      new Date(baseNow.getTime() + 3 * day).toISOString()
    );
  });

  it("scopes cooldown to the dismissing user — another user's dismiss does not suppress this user", async () => {
    await seedWork();
    const capture = await seedCapture("note-1", "blk-1", "hello", new Date("2026-02-01T00:00:00Z"));

    // Another user dismisses the same chunk id directly into their own state.
    await context.db.insert(nudgeState).values({
      chunkId: capture.chunkId,
      dismissedUntil: new Date(baseNow.getTime() + 3 * day),
      lastSurfacedAt: null,
      userId: otherUser
    });

    expect((await getNudge())?.chunkId).toBe(capture.chunkId);
  });
});

describe("the practice lead uses the same ranked + cooldown selection", () => {
  it("leads startSession with the proposed nudge's case, targeting the captured text", async () => {
    await seedWork();
    await seedCapture("note-old", "blk-old", "older phrase", new Date("2026-01-15T00:00:00Z"));
    const newer = await seedCapture(
      "note-new",
      "blk-new",
      "thrive under pressure",
      new Date("2026-02-15T00:00:00Z")
    );

    const nudge = await getNudge();
    const plan = await startSession(context.session, DEFAULT_USER_ID, baseNow);

    expect(nudge?.caseId).toBe(newer.caseId);
    expect(plan.cues[0]?.caseId).toBe(newer.caseId);
    expect(plan.cues[0]?.chunkId).toBe(newer.chunkId);
    expect(plan.cues[0]?.target).toBe("thrive under pressure");
  });

  it("a practised chunk does not immediately re-surface — the next-best capture leads instead", async () => {
    await seedWork();
    const older = await seedCapture(
      "note-old",
      "blk-old",
      "older phrase",
      new Date("2026-01-15T00:00:00Z")
    );
    const newer = await seedCapture(
      "note-new",
      "blk-new",
      "thrive under pressure",
      new Date("2026-02-15T00:00:00Z")
    );

    // The newer capture leads first; practise it so its chunk gains review state (lower gap).
    expect((await getNudge())?.chunkId).toBe(newer.chunkId);
    await startSession(context.session, DEFAULT_USER_ID, baseNow);
    const turn = await submitTurn(
      context.session,
      { chunkId: newer.chunkId, transcript: "thrive under pressure" },
      DEFAULT_USER_ID,
      baseNow
    );
    expect(turn.status).toBe("ok");

    // The practised chunk no longer leads; the next-best (higher-gap) capture surfaces instead.
    expect((await getNudge())?.chunkId).toBe(older.chunkId);
  });

  it("falls back to authored cases at cold start — no harvested lead", async () => {
    const plan = await startSession(context.session, DEFAULT_USER_ID, baseNow);

    expect(await getNudge()).toBeNull();
    expect(plan.cues.length).toBeGreaterThan(0);
    expect(plan.cues[0]?.chunkId.startsWith("harvest-chunk-")).toBe(false);
  });
});
