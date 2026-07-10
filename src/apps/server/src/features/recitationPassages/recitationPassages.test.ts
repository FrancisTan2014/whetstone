import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DueRecitationPassageResponse,
  RecitationPassageDto,
  RecitationPassageListDto,
  RecordRecitationReviewResponse
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  readingUnits,
  recitationPassages,
  workMeta
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { RecitationRouteDependencies } from "../recitation/recitationRoutes.js";
import type { RecitationPassageRouteDependencies } from "./recitationPassageRoutes.js";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
  setNow: (iso: string) => void;
  setUser: (id: string) => void;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = new Date("2026-07-01T09:00:00.000Z");
  let userId = DEFAULT_USER_ID;
  let sequence = 0;
  const recitation: RecitationRouteDependencies = {
    createEntryId: () => `plan-${(sequence += 1)}`,
    db,
    now: () => now
  };
  const recitationPassages: RecitationPassageRouteDependencies = {
    createEntryId: () => `passage-${(sequence += 1)}`,
    createId: () => `review-${(sequence += 1)}`,
    db,
    now: () => now
  };

  return {
    db,
    server: createServer({
      currentUser: { getCurrentUserId: () => userId },
      logger: false,
      recitation,
      recitationPassages
    }),
    setNow: (iso) => {
      now = new Date(iso);
    },
    setUser: (id) => {
      userId = id;
    }
  };
}

// An imported Work with reading-unit and PM block rows, so passages can be seeded from real source text.
// Each block is also an `entries` row (a passage range FKs the block ids to `entries.id`).
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
      title: "The Recitation",
      workType: "book"
    });
    await tx.insert(entries).values({ id: unitId, type: "reading_unit" });
    await tx.insert(readingUnits).values({
      entryId: unitId,
      orderIndex: 0,
      title: "Chapter",
      workEntryId
    });
    let order = 0;
    for (const block of blocks) {
      await tx.insert(entries).values({ id: block.id, type: "block" });
      await tx.insert(docBlocks).values({
        id: block.id,
        nodeJson: { content: [], type: "paragraph" },
        orderIndex: order,
        plaintext: block.text,
        readingUnitEntryId: unitId,
        type: "paragraph",
        workEntryId
      });
      order += 1;
    }
  });
}

// Adopt an already-seeded Work as a recitation plan for the current user (its `personal_entries` facet
// is what makes a passage owner-scoped).
async function adopt(workEntryId: string): Promise<string> {
  const response = await context.server.inject({
    method: "POST",
    payload: { phase: "familiarizing", workEntryId },
    url: "/api/recitation/plans"
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { entryId: string }).entryId;
}

async function seedPassages(planEntryId: string): Promise<{ code: number; body: RecitationPassageListDto }> {
  const response = await context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/passages/seed`
  });
  return { body: response.json() as RecitationPassageListDto, code: response.statusCode };
}

async function listPassages(planEntryId: string): Promise<RecitationPassageListDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/recitation/plans/${planEntryId}/passages`
  });
  expect(response.statusCode).toBe(200);
  return response.json() as RecitationPassageListDto;
}

async function loadDue(): Promise<DueRecitationPassageResponse> {
  const response = await context.server.inject({ method: "GET", url: "/api/recitation/passages/due" });
  expect(response.statusCode).toBe(200);
  return response.json() as DueRecitationPassageResponse;
}

// A plan whose Work has two recitable blocks (with a blank block between that must never seed a passage).
async function seededTwoPassagePlan(): Promise<{
  planEntryId: string;
  workEntryId: string;
  passages: ReadonlyArray<RecitationPassageDto>;
}> {
  const workEntryId = "work-1";
  await seedWorkWithBlocks(workEntryId, [
    { id: "block-a", text: "The quick brown fox." },
    { id: "block-blank", text: "   " },
    { id: "block-c", text: "Jumps over the lazy dog." }
  ]);
  const planEntryId = await adopt(workEntryId);
  const seeded = await seedPassages(planEntryId);
  expect(seeded.code).toBe(201);
  return { passages: seeded.body.passages, planEntryId, workEntryId };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("POST /api/recitation/plans/:id/passages/seed", () => {
  it("seeds one passage per non-blank block in source order, skipping blank blocks", async () => {
    const { passages } = await seededTwoPassagePlan();

    expect(passages).toHaveLength(2);
    expect(passages.map((passage) => passage.sourceText)).toEqual([
      "The quick brown fox.",
      "Jumps over the lazy dog."
    ]);
    expect(passages.map((passage) => passage.orderIndex)).toEqual([0, 1]);
    expect(passages[0]).toMatchObject({
      anchorStatus: "anchored",
      endBlockEntryId: "block-a",
      endOffset: "The quick brown fox.".length,
      lastReviewedAt: null,
      planEntryId: "plan-1",
      reviewCount: 0,
      startBlockEntryId: "block-a",
      startOffset: 0
    });
    expect(passages[1]).toMatchObject({ startBlockEntryId: "block-c", endBlockEntryId: "block-c" });
  });

  it("is idempotent — a second seed returns the existing passages unchanged", async () => {
    const { planEntryId, passages } = await seededTwoPassagePlan();

    const again = await seedPassages(planEntryId);

    expect(again.code).toBe(200);
    expect(again.body.passages.map((passage) => passage.entryId)).toEqual(
      passages.map((passage) => passage.entryId)
    );
  });

  it("seeds no passages for a Work with only blank blocks", async () => {
    await seedWorkWithBlocks("work-blank", [{ id: "only-blank", text: "   " }]);
    const planEntryId = await adopt("work-blank");

    const seeded = await seedPassages(planEntryId);

    expect(seeded.code).toBe(201);
    expect(seeded.body.passages).toEqual([]);
  });

  it("is 404 for a plan the user does not own", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/recitation/plans/forged/passages/seed"
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/recitation/plans/:id/passages", () => {
  it("lists a plan's passages with their review counts", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();
    await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "good" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });

    const listed = await listPassages(planEntryId);

    expect(listed.planEntryId).toBe(planEntryId);
    expect(listed.passages.map((passage) => passage.reviewCount)).toEqual([1, 0]);
  });

  it("returns an empty list for an adopted but un-seeded plan", async () => {
    await seedWorkWithBlocks("work-2", [{ id: "b1", text: "Hello world." }]);
    const planEntryId = await adopt("work-2");

    const listed = await listPassages(planEntryId);

    expect(listed.passages).toEqual([]);
  });

  it("is 404 for a plan the user does not own", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/recitation/plans/forged/passages"
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/recitation/passages/:id/split", () => {
  it("splits a passage into two contiguous passages and reindexes the rest", async () => {
    const { planEntryId, passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { atBlockEntryId: "block-a", atOffset: 4 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { passages: RecitationPassageDto[]; planEntryId: string };
    expect(body.planEntryId).toBe(planEntryId);
    expect(body.passages.map((passage) => passage.sourceText)).toEqual([
      "The ",
      "quick brown fox.",
      "Jumps over the lazy dog."
    ]);
    expect(body.passages.map((passage) => passage.orderIndex)).toEqual([0, 1, 2]);
  });

  it("is 400 for a malformed body", async () => {
    const { passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { atOffset: 4 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("is 422 invalid_split when the cut is on a boundary", async () => {
    const { passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { atBlockEntryId: "block-a", atOffset: 0 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_split", reason: "at_boundary" });
  });

  it("is 422 invalid_split when the offset is out of range", async () => {
    const { passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { atBlockEntryId: "block-a", atOffset: 999 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_split", reason: "out_of_range" });
  });

  it("is 404 for a passage the user does not own", async () => {
    const { passages } = await seededTwoPassagePlan();
    context.setUser(OTHER_USER_ID);

    const response = await context.server.inject({
      method: "POST",
      payload: { atBlockEntryId: "block-a", atOffset: 4 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/recitation/passages/:id/merge-next", () => {
  it("merges a passage with the next one across a block boundary and reindexes", async () => {
    const { planEntryId, passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/passages/${passages[0]!.entryId}/merge-next`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { passages: RecitationPassageDto[]; planEntryId: string };
    expect(body.planEntryId).toBe(planEntryId);
    expect(body.passages).toHaveLength(1);
    expect(body.passages[0]).toMatchObject({
      endBlockEntryId: "block-c",
      orderIndex: 0,
      sourceText: "The quick brown fox.\nJumps over the lazy dog.",
      startBlockEntryId: "block-a"
    });
  });

  it("is 422 no_adjacent_passage when merging the last passage", async () => {
    const { passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/passages/${passages[1]!.entryId}/merge-next`
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "no_adjacent_passage" });
  });

  it("captures an empty snapshot when a merged source block was removed", async () => {
    const { passages } = await seededTwoPassagePlan();
    // Simulate re-ingestion dropping the next passage's block (its addressable Entry, hence the passage
    // FK, remains): the merged snapshot has no live text to cover.
    await context.db.delete(docBlocks).where(eq(docBlocks.id, "block-c"));

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/passages/${passages[0]!.entryId}/merge-next`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { passages: RecitationPassageDto[] };
    expect(body.passages).toHaveLength(1);
    expect(body.passages[0]!.sourceText).toBe("");
  });

  it("is 404 for a passage the user does not own", async () => {
    const { passages } = await seededTwoPassagePlan();
    context.setUser(OTHER_USER_ID);

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/passages/${passages[0]!.entryId}/merge-next`
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/recitation/passages/:id/review", () => {
  it("records a self-assessment, advances the FSRS schedule, and logs the review", async () => {
    const { passages } = await seededTwoPassagePlan();

    const first = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "good" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });

    expect(first.statusCode).toBe(200);
    const body = first.json() as RecordRecitationReviewResponse;
    expect(body.passage.reviewCount).toBe(1);
    expect(body.passage.reps).toBe(1);
    expect(body.passage.lastReviewedAt).not.toBeNull();
    expect(new Date(body.passage.dueAt).getTime()).toBeGreaterThan(
      new Date("2026-07-01T09:00:00.000Z").getTime()
    );

    // A second review reads the now-reviewed card (non-null last-reviewed) and keeps counting.
    context.setNow("2026-07-02T09:00:00.000Z");
    const second = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "preceding_line", rating: "again" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as RecordRecitationReviewResponse).passage.reviewCount).toBe(2);
  });

  it("is 400 for a malformed body", async () => {
    const { passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "sideways" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("is 404 for a passage the user does not own", async () => {
    const { passages } = await seededTwoPassagePlan();
    context.setUser(OTHER_USER_ID);

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "good" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/recitation/passages/due", () => {
  it("is null when nothing is due", async () => {
    const due = await loadDue();

    expect(due.passage).toBeNull();
  });

  it("serves the first passage with an opening default cue when its source is unchanged", async () => {
    const { passages } = await seededTwoPassagePlan();

    const due = await loadDue();

    expect(due.passage).toMatchObject({
      anchorStatus: "anchored",
      defaultCueStrength: "opening",
      passageEntryId: passages[0]!.entryId,
      precedingText: null,
      targetText: "The quick brown fox.",
      workTitle: "The Recitation"
    });
  });

  it("defaults a later passage to a preceding_line cue carrying the previous passage's text", async () => {
    const { passages } = await seededTwoPassagePlan();
    // Push the first passage into the future so the second becomes the next due passage.
    await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "easy" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });

    const due = await loadDue();

    expect(due.passage).toMatchObject({
      defaultCueStrength: "preceding_line",
      passageEntryId: passages[1]!.entryId,
      precedingText: "The quick brown fox.",
      targetText: "Jumps over the lazy dog."
    });
  });

  it("re-anchors in place when the source text moved within its block", async () => {
    const { passages } = await seededTwoPassagePlan();
    await context.db
      .update(docBlocks)
      .set({ plaintext: "PREFIX. The quick brown fox." })
      .where(eq(docBlocks.id, "block-a"));

    const due = await loadDue();

    expect(due.passage).toMatchObject({ anchorStatus: "anchored", targetText: "The quick brown fox." });
    const [row] = await context.db
      .select()
      .from(recitationPassages)
      .where(eq(recitationPassages.entryId, passages[0]!.entryId));
    expect(row?.startOffset).toBe("PREFIX. ".length);
  });

  it("marks a passage needs_repair when its source can no longer be located", async () => {
    const { passages } = await seededTwoPassagePlan();
    await context.db
      .update(docBlocks)
      .set({ plaintext: "Entirely different text." })
      .where(eq(docBlocks.id, "block-a"));

    const due = await loadDue();

    expect(due.passage).toMatchObject({
      anchorStatus: "needs_repair",
      passageEntryId: passages[0]!.entryId
    });
  });
});
