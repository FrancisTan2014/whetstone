import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localDayKey } from "@whetstone/domain";

import type { TodayBoardDto, TodayBoardResponse } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  readerPreferences,
  readingUnits,
  reviewCards,
  workMeta
} from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { depositMemory, type MemoryDependencies } from "../memory/memoryCommands.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";
import type { RecitationChainingRouteDependencies } from "../recitationPassages/recitationChainingRoutes.js";
import type { RecitationPassageRouteDependencies } from "../recitationPassages/recitationPassageRoutes.js";
import type { RecitationRouteDependencies } from "../recitation/recitationRoutes.js";
import { loadTodayBoard } from "./todayQueries.js";

const START = "2026-07-01T12:00:00.000Z";

type TestContext = Readonly<{
  db: DbClient;
  memory: MemoryDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (iso: string) => void;
  sourcesDir: string;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-today-"));

  let now = new Date(START);
  let sequence = 0;
  const nowFn = (): Date => now;

  const recitation: RecitationRouteDependencies = {
    createEntryId: () => `plan-${(sequence += 1)}`,
    db,
    now: nowFn
  };
  const recitationPassages: RecitationPassageRouteDependencies = {
    createEntryId: () => `passage-${(sequence += 1)}`,
    createId: () => `review-${(sequence += 1)}`,
    db,
    now: nowFn
  };
  const recitationChaining: RecitationChainingRouteDependencies = {
    createEntryId: () => `whole-work-${(sequence += 1)}`,
    createId: () => `chain-${(sequence += 1)}`,
    db,
    now: nowFn
  };
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(sequence += 1)}`,
    createEntryId: () => `work-${(sequence += 1)}`,
    db
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(sequence += 1)}`,
    createSourceId: () => `source-${(sequence += 1)}`,
    db,
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };
  const memory: MemoryDependencies = { createId: () => `memory-${(sequence += 1)}`, db };

  return {
    db,
    memory,
    server: createServer({
      content,
      currentUser: { getCurrentUserId: () => DEFAULT_USER_ID },
      library,
      logger: false,
      readingPosition: { db },
      recitation,
      recitationChaining,
      recitationPassages,
      today: { db, now: nowFn }
    }),
    setNow: (iso) => {
      now = new Date(iso);
    },
    sourcesDir
  };
}

async function getBoard(): Promise<TodayBoardDto> {
  const response = await context.server.inject({ method: "GET", url: "/api/today" });
  expect(response.statusCode).toBe(200);
  return (response.json() as TodayBoardResponse).board;
}

// --- Recitation seeding (mirrors recitationSession.test.ts) ------------------------------------

async function seedWorkWithBlocks(
  workEntryId: string,
  blocks: ReadonlyArray<Readonly<{ id: string; text: string }>>
): Promise<void> {
  const unitId = `${workEntryId}-unit`;
  await context.db.transaction(async (tx) => {
    await tx.insert(authors).values({ id: `${workEntryId}-author`, name: "Aesop" });
    await tx.insert(entries).values({ id: workEntryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: `${workEntryId}-author`,
      entryId: workEntryId,
      language: "en",
      title: `Work ${workEntryId}`,
      workType: "book"
    });
    await tx.insert(entries).values({ id: unitId, type: "reading_unit" });
    await tx.insert(readingUnits).values({
      entryId: unitId,
      orderIndex: 0,
      title: "Chapter",
      workEntryId
    });
    for (const [orderIndex, block] of blocks.entries()) {
      await tx.insert(entries).values({ id: block.id, type: "block" });
      await tx.insert(docBlocks).values({
        id: block.id,
        nodeJson: { content: [], type: "paragraph" },
        orderIndex,
        plaintext: block.text,
        readingUnitEntryId: unitId,
        type: "paragraph",
        workEntryId
      });
    }
  });
}

async function seedPlan(
  workEntryId: string,
  texts: readonly string[]
): Promise<{ passageIds: string[]; planEntryId: string }> {
  await seedWorkWithBlocks(
    workEntryId,
    texts.map((text, index) => ({ id: `${workEntryId}-b${index}`, text }))
  );
  const adopt = await context.server.inject({
    method: "POST",
    payload: { phase: "learning", workEntryId },
    url: "/api/recitation/plans"
  });
  expect(adopt.statusCode).toBe(201);
  const planEntryId = (adopt.json() as { entryId: string }).entryId;
  const seeded = await context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/passages/seed`
  });
  expect(seeded.statusCode).toBe(201);
  const passageIds = (
    seeded.json() as { passages: ReadonlyArray<{ entryId: string }> }
  ).passages.map((passage) => passage.entryId);
  return { passageIds, planEntryId };
}

async function introduceNext(planEntryId: string): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/introduce-next`
  });
  expect(response.statusCode).toBe(200);
}

async function ownPassage(passageEntryId: string): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "good" },
      url: `/api/recitation/passages/${passageEntryId}/review`
    });
    expect(response.statusCode).toBe(200);
  }
}

async function setRecitationDueAt(passageEntryId: string, iso: string): Promise<void> {
  await context.db
    .update(reviewCards)
    .set({ dueAt: new Date(iso) })
    .where(eq(reviewCards.targetEntryId, passageEntryId));
}

async function pausePlan(planEntryId: string): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/pause`
  });
  expect(response.statusCode).toBe(200);
}

async function reviewWholeWork(planEntryId: string): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { outcome: { status: "held" }, rating: "good" },
    url: `/api/recitation/plans/${planEntryId}/whole-work/review`
  });
  expect(response.statusCode).toBe(200);
}

// --- Memory seeding ---------------------------------------------------------------------------

async function seedMemoryPrompt(now: Date): Promise<string> {
  const deposit = await depositMemory(
    context.memory,
    {
      captureSource: "diary",
      noteText: "cue",
      prompts: [{ answerText: "answer", cueText: "cue" }]
    },
    DEFAULT_USER_ID,
    now
  );
  return deposit.prompts[0]!.promptId;
}

async function setMemoryDueAt(promptId: string, iso: string): Promise<void> {
  await context.db
    .update(reviewCards)
    .set({ dueAt: new Date(iso) })
    .where(eq(reviewCards.targetEntryId, promptId));
}

async function setTimeZone(timeZone: string): Promise<void> {
  await context.db.insert(readerPreferences).values({
    readingSize: "medium",
    theme: "day",
    timezone: timeZone,
    userId: DEFAULT_USER_ID
  });
}

// --- Reading seeding (via the real routes) ----------------------------------------------------

async function seedReadingPosition(): Promise<
  Readonly<{ unitEntryId: string; workEntryId: string }>
> {
  const workResponse = await context.server.inject({
    method: "POST",
    payload: {
      author: { mode: "new", name: "Aesop" },
      language: "en",
      title: "Fables",
      workType: "classical_text"
    },
    url: "/api/works"
  });
  const workEntryId = workResponse.json().work.entryId as string;
  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox." },
    url: `/api/works/${workEntryId}/content`
  });
  const structure = (
    await context.server.inject({ method: "GET", url: `/api/works/${workEntryId}/structure` })
  ).json() as { readingUnits: ReadonlyArray<{ entryId: string }> };
  const unitEntryId = structure.readingUnits[0]!.entryId;
  const put = await context.server.inject({
    method: "PUT",
    payload: { unitEntryId },
    url: `/api/works/${workEntryId}/reading-position`
  });
  expect(put.statusCode).toBe(204);
  return { unitEntryId, workEntryId };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
  await rm(context.sourcesDir, { force: true, recursive: true });
});

describe("GET /api/today", () => {
  it("reports a truthful clear board when nothing is due and no source failed", async () => {
    const board = await getBoard();

    expect(board).toEqual({
      clear: true,
      continueReading: { status: "empty" },
      continueWriting: { status: "empty" },
      date: localDayKey(new Date(START), "UTC"),
      dueNow: [],
      newPassage: { status: "unavailable" },
      routineFailures: []
    });
  });

  it("groups each due routine into one row and orders overdue routines first", async () => {
    // Recitation: two owned passages, both due, at least one overdue -> one grouped, overdue row.
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    await setRecitationDueAt(passageIds[0]!, "2026-06-30T23:00:00.000Z");
    await setRecitationDueAt(passageIds[1]!, "2026-06-30T22:00:00.000Z");
    // Memory: a single card due today (not overdue) -> ordered after the overdue recitation routine.
    const promptId = await seedMemoryPrompt(new Date(START));
    await setMemoryDueAt(promptId, "2026-07-01T06:00:00.000Z");

    const board = await getBoard();

    expect(board.clear).toBe(false);
    expect(board.dueNow).toEqual([
      {
        dueCount: 2,
        kind: "recitation",
        nextDueAt: "2026-06-30T22:00:00.000Z",
        overdue: true,
        overdueCount: 2
      },
      {
        dueCount: 1,
        kind: "memory",
        nextDueAt: "2026-07-01T06:00:00.000Z",
        overdue: false,
        overdueCount: 0
      }
    ]);
  });

  it("excludes a paused plan and a not-due prompt, staying clear", async () => {
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await setRecitationDueAt(passageIds[0]!, "2026-06-30T23:00:00.000Z");
    await pausePlan(planEntryId);
    const promptId = await seedMemoryPrompt(new Date(START));
    await setMemoryDueAt(promptId, "2026-07-05T00:00:00.000Z");

    const board = await getBoard();

    expect(board.clear).toBe(true);
    expect(board.dueNow).toEqual([]);
    expect(board.routineFailures).toEqual([]);
    expect(board.newPassage).toEqual({ status: "unavailable" });
  });

  it("surfaces an available new passage as an invitation that never blocks the clear state", async () => {
    // Passages seeded but none introduced: nothing is due, yet a new passage is available to start.
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two."]);

    const board = await getBoard();

    expect(board.clear).toBe(true);
    expect(board.dueNow).toEqual([]);
    expect(board.newPassage).toEqual({ planEntryId, status: "available" });
  });

  it("keeps Recitation due when a required chain step has no due card, never a false clear", async () => {
    // Own both passages and retire the whole-Work prompt, leaving an eligible owned-prefix chain with no
    // active chain and no due review card: the session sits on the `chain` step while `due.nextDueAt` is
    // null. A card-only Today would drop the row and falsely report clear; Today must keep it due (#610).
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    await reviewWholeWork(planEntryId);

    const board = await getBoard();

    expect(board.clear).toBe(false);
    expect(board.dueNow).toEqual([
      {
        dueCount: 1,
        kind: "recitation",
        nextDueAt: START,
        overdue: false,
        overdueCount: 0
      }
    ]);
  });

  it("applies the learner's local-day boundary when classifying overdue", async () => {
    // 12:00Z is 08:00 in New York (UTC-4): the local day starts 04:00Z. A card due 02:00Z is before the
    // learner's local midnight -> overdue, though it is after UTC midnight (a server-UTC bug would miss it).
    await setTimeZone("America/New_York");
    const promptId = await seedMemoryPrompt(new Date(START));
    await setMemoryDueAt(promptId, "2026-07-01T02:00:00.000Z");

    const board = await getBoard();

    expect(board.date).toBe(localDayKey(new Date(START), "America/New_York"));
    expect(board.dueNow).toEqual([
      {
        dueCount: 1,
        kind: "memory",
        nextDueAt: "2026-07-01T02:00:00.000Z",
        overdue: true,
        overdueCount: 1
      }
    ]);
  });

  it("marks only the failing routine and never presents a false clear when a source throws", async () => {
    // Drop the memory table so its query throws: memory is marked failed while recitation stays clear.
    await context.db.$client.query("DROP TABLE memory_prompts CASCADE");

    const board = await getBoard();

    expect(board.routineFailures).toEqual(["memory"]);
    expect(board.clear).toBe(false);
    expect(board.dueNow).toEqual([]);
  });

  it("offers the latest reading position as a Continue invitation", async () => {
    const { unitEntryId, workEntryId } = await seedReadingPosition();

    const board = await getBoard();

    expect(board.continueReading.status).toBe("ready");
    if (board.continueReading.status === "ready") {
      expect(board.continueReading.position.unitEntryId).toBe(unitEntryId);
      expect(board.continueReading.position.workEntryId).toBe(workEntryId);
      expect(board.continueReading.position.workTitle).toBe("Fables");
    }
  });
});

describe("loadTodayBoard failure handling", () => {
  it("fails every source and blocks the clear state when the database is unavailable", async () => {
    // A database that throws on any query drives every guarded source into its failed branch.
    const throwingDb = {
      select: () => {
        throw new Error("database unavailable");
      }
    } as unknown as DbClient;

    const board = await loadTodayBoard({ db: throwingDb }, DEFAULT_USER_ID, new Date(START), "UTC");

    expect(board).toEqual({
      clear: false,
      continueReading: { status: "failed" },
      continueWriting: { status: "failed" },
      date: localDayKey(new Date(START), "UTC"),
      dueNow: [],
      newPassage: { status: "failed" },
      routineFailures: ["recitation", "memory"]
    });
  });
});
