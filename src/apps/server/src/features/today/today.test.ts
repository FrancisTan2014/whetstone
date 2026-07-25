import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localDayKey, newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";

import type { TodayBoardDto, TodayBoardResponse } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  memoryPrompts,
  notes,
  personalEntries,
  readerPreferences,
  readingUnits,
  recitationWholeWork,
  reviewCards,
  workMeta
} from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import { createWork } from "../library/libraryCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";
import type { RecitationRouteDependencies } from "../recitation/recitationRoutes.js";
import { reviewStateColumns } from "../review/reviewCardQueries.js";
import { loadTodayBoard } from "./todayQueries.js";

const START = "2026-07-01T12:00:00.000Z";

type TestContext = Readonly<{
  db: DbClient;
  library: LibraryDependencies;
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
    createId: () => `review-${(sequence += 1)}`,
    db,
    now: nowFn
  };
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(sequence += 1)}`,
    createEntryId: () => `work-${(sequence += 1)}`,
    db,
    now: () => new Date()
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(sequence += 1)}`,
    createSourceId: () => `source-${(sequence += 1)}`,
    db,
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return {
    db,
    library,
    server: createServer({
      content,
      currentUser: { getCurrentUserId: () => DEFAULT_USER_ID },
      library,
      logger: false,
      readingPosition: { db },
      recitation,
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
      origin: "imported",
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

async function enrollWork(
  workEntryId: string,
  texts: readonly string[]
): Promise<{ planEntryId: string; targetEntryId: string }> {
  await seedWorkWithBlocks(
    workEntryId,
    texts.map((text, index) => ({ id: `${workEntryId}-b${index}`, text }))
  );
  const response = await context.server.inject({
    method: "POST",
    payload: { workEntryId },
    url: "/api/recitation/enroll"
  });
  expect(response.statusCode).toBe(200);
  const planEntryId = (response.json() as { entryId: string }).entryId;
  const [target] = await context.db
    .select({ entryId: recitationWholeWork.entryId })
    .from(recitationWholeWork)
    .where(eq(recitationWholeWork.planEntryId, planEntryId));
  return { planEntryId, targetEntryId: target!.entryId };
}

async function setRecitationDueAt(targetEntryId: string, iso: string): Promise<void> {
  await context.db
    .update(reviewCards)
    .set({ dueAt: new Date(iso) })
    .where(eq(reviewCards.targetEntryId, targetEntryId));
}

async function pausePlan(planEntryId: string): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/pause`
  });
  expect(response.statusCode).toBe(200);
}

// --- Note-review seeding ----------------------------------------------------------------------

let notePromptSeq = 0;

// Seed a Notes-owned ready prompt (a saved note + its current-note prompt + an active due card) directly,
// the shape the retired Memory deposit produced — so the Today note-review routine has a due card.
async function seedMemoryPrompt(now: Date): Promise<string> {
  const noteId = `note-${(notePromptSeq += 1)}`;
  const promptId = `note-prompt-${(notePromptSeq += 1)}`;
  await context.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: noteId, type: "note" });
    await tx.insert(personalEntries).values({
      entryId: noteId,
      userId: DEFAULT_USER_ID,
      occurredAt: now,
      createdAt: now,
      updatedAt: now
    });
    await tx.insert(notes).values({
      bodyDoc: createTextDocument("cue"),
      bodyText: "cue",
      captureSource: "manual",
      entryId: noteId,
      kind: "note"
    });
    await tx.insert(entries).values({ id: promptId, type: "memory_prompt" });
    await tx.insert(memoryPrompts).values({
      answerDoc: null,
      answerText: null,
      chunkId: null,
      createdAt: now,
      cueDoc: createTextDocument("cue"),
      cueText: "cue",
      entryId: promptId,
      lifecycle: "ready",
      noteEntryId: noteId,
      revealKind: "current_note"
    });
    await tx.insert(reviewCards).values({
      ...reviewStateColumns(newReviewState(now)),
      requestedRetention: RECALL_REQUEST_RETENTION,
      status: "active",
      targetEntryId: promptId,
      userId: DEFAULT_USER_ID
    });
  });
  return promptId;
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
  const created = await createWork(
    context.library,
    {
      author: { mode: "new", name: "Aesop" },
      language: "en",
      origin: "imported",
      title: "Fables",
      workType: "classical_text"
    },
    DEFAULT_USER_ID
  );
  if (created.status !== "created") {
    throw new Error("expected the imported seed Work to be created");
  }
  const workEntryId = created.work.work.entryId;
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
      nextReviewAt: null,
      routineFailures: []
    });
  });

  it("groups each due routine into one row and orders overdue routines first", async () => {
    // Recitation: two enrolled Works, both Work-level cards due and overdue -> one grouped, overdue row.
    const first = await enrollWork("work-1", ["One.", "Two."]);
    const second = await enrollWork("work-2", ["Three."]);
    await setRecitationDueAt(first.targetEntryId, "2026-06-30T23:00:00.000Z");
    await setRecitationDueAt(second.targetEntryId, "2026-06-30T22:00:00.000Z");
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

  it("excludes a paused plan and a not-due prompt, staying clear and reporting the next review", async () => {
    const { planEntryId, targetEntryId } = await enrollWork("work-1", ["One."]);
    await setRecitationDueAt(targetEntryId, "2026-06-30T23:00:00.000Z");
    await pausePlan(planEntryId);
    const promptId = await seedMemoryPrompt(new Date(START));
    await setMemoryDueAt(promptId, "2026-07-05T00:00:00.000Z");

    const board = await getBoard();

    expect(board.clear).toBe(true);
    expect(board.dueNow).toEqual([]);
    expect(board.routineFailures).toEqual([]);
    // The paused plan is out of due selection entirely; the future note prompt is the next known review.
    expect(board.nextReviewAt).toBe("2026-07-05T00:00:00.000Z");
  });

  it("reports a Work's future maintenance card as the next review on a clear board", async () => {
    const { targetEntryId } = await enrollWork("work-1", ["One."]);
    // Push the freshly-enrolled (due-now) card into the future: nothing is due, so the board is clear and
    // reports that scheduled instant as the next known review time.
    await setRecitationDueAt(targetEntryId, "2026-07-09T00:00:00.000Z");

    const board = await getBoard();

    expect(board.clear).toBe(true);
    expect(board.dueNow).toEqual([]);
    expect(board.nextReviewAt).toBe("2026-07-09T00:00:00.000Z");
  });

  it("surfaces the enrolled Work's due-now maintenance card as a single Recitation row", async () => {
    // A freshly enrolled Work has one Work-level card due immediately (requested retention 0.95): Today
    // surfaces exactly one recitation row with the card's due instant, and no passage/chain state is needed.
    await enrollWork("work-1", ["One.", "Two."]);

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
      nextReviewAt: null,
      routineFailures: ["recitation", "memory"]
    });
  });
});
