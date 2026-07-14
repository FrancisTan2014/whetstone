import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ActivateNextRecitationPassageResponse,
  DueRecitationPassageResponse,
  RecitationIntroductionStatusDto,
  RecitationPassageDto,
  RecitationPassageListDto,
  RecitationPhaseDto,
  RecordRecitationReviewResponse
} from "@whetstone/contracts";
import {
  applyRating,
  newReviewState,
  RECALL_REQUEST_RETENTION,
  RECITATION_DAILY_INTRODUCTION_CAP,
  RECITATION_REQUEST_RETENTION
} from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  readerPreferences,
  readingUnits,
  recitationPassages,
  reviewCards,
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
// is what makes a passage owner-scoped). Defaults to `learning` — the phase in which passage practice is
// available (#578); pass another phase to exercise the segmentation/due-queue phase gate.
async function adopt(workEntryId: string, phase: RecitationPhaseDto = "learning"): Promise<string> {
  const response = await context.server.inject({
    method: "POST",
    payload: { phase, workEntryId },
    url: "/api/recitation/plans"
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { entryId: string }).entryId;
}

// Move an existing plan to another phase (the learner's explicit transition, e.g. "Start reciting").
async function setPhase(planEntryId: string, phase: RecitationPhaseDto): Promise<void> {
  const response = await context.server.inject({
    method: "PUT",
    payload: { phase },
    url: `/api/recitation/plans/${planEntryId}/phase`
  });
  expect(response.statusCode).toBe(200);
}

async function seedPassages(
  planEntryId: string
): Promise<{ code: number; body: RecitationPassageListDto }> {
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
  const response = await context.server.inject({
    method: "GET",
    url: "/api/recitation/passages/due"
  });
  expect(response.statusCode).toBe(200);
  return response.json() as DueRecitationPassageResponse;
}

// Explicitly introduce the next queued passage of a Learning plan (#607) — the paced "Start first
// passage" / "New passage" action that stamps `introduced_at` and seeds its active review card.
async function introduceNext(
  planEntryId: string
): Promise<ReturnType<TestContext["server"]["inject"]>> {
  return context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/introduce-next`
  });
}

// The paced introduction status a Learning plan serves (#607): due count, capacity, next queued preview.
async function getIntroduction(planEntryId: string): Promise<RecitationIntroductionStatusDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/recitation/plans/${planEntryId}/introduction`
  });
  expect(response.statusCode).toBe(200);
  return response.json() as RecitationIntroductionStatusDto;
}

async function setSupportLevel(
  passageEntryId: string,
  supportLevel: string
): Promise<ReturnType<TestContext["server"]["inject"]>> {
  return context.server.inject({
    method: "PUT",
    payload: { supportLevel },
    url: `/api/recitation/passages/${passageEntryId}/support-level`
  });
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

// The same two-passage learning plan, with the FIRST passage explicitly introduced (#607) so it owns an
// active card and is due — the arrange step for the due/support tests that need live practice.
async function seededTwoPassagePlanFirstIntroduced(): Promise<{
  planEntryId: string;
  workEntryId: string;
  passages: ReadonlyArray<RecitationPassageDto>;
}> {
  const plan = await seededTwoPassagePlan();
  const introduced = await introduceNext(plan.planEntryId);
  expect(introduced.statusCode).toBe(200);
  return plan;
}

// A maintenance plan whose Work has two recitable blocks; its passages seed as queued (#605).
async function seededMaintenancePlan(): Promise<{
  planEntryId: string;
  passages: ReadonlyArray<RecitationPassageDto>;
}> {
  const workEntryId = "work-maint";
  await seedWorkWithBlocks(workEntryId, [
    { id: "maint-a", text: "The quick brown fox." },
    { id: "maint-c", text: "Jumps over the lazy dog." }
  ]);
  const planEntryId = await adopt(workEntryId, "maintenance");
  const seeded = await seedPassages(planEntryId);
  expect(seeded.code).toBe(201);
  return { passages: seeded.body.passages, planEntryId };
}

// A learning plan whose Work has `count` recitable blocks, all seeded QUEUED (#607) — the arrange step
// for pacing/capacity tests that need more than two passages in the queue.
async function seededLearningPlan(count: number): Promise<{
  planEntryId: string;
  passages: ReadonlyArray<RecitationPassageDto>;
}> {
  const workEntryId = "work-n";
  await seedWorkWithBlocks(
    workEntryId,
    Array.from({ length: count }, (_unused, index) => ({
      id: `n-block-${index}`,
      text: `Passage number ${index}.`
    }))
  );
  const planEntryId = await adopt(workEntryId);
  const seeded = await seedPassages(planEntryId);
  expect(seeded.code).toBe(201);
  return { passages: seeded.body.passages, planEntryId };
}

// Review a passage at the current clock (default "easy" pushes its next due well into the future, so the
// plan has no due work and another passage may be introduced).
async function review(passageEntryId: string, rating = "easy"): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { cueStrength: "opening", rating },
    url: `/api/recitation/passages/${passageEntryId}/review`
  });
  expect(response.statusCode).toBe(200);
}

// Persist the learner's calendar-day zone (#606) so the local-day cap resolves against it, not UTC.
async function setLearnerTimeZone(timeZone: string): Promise<void> {
  await context.db
    .insert(readerPreferences)
    .values({ readingSize: "medium", theme: "light", timezone: timeZone, userId: DEFAULT_USER_ID });
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
    // Learning now seeds QUEUED passages (#607): introduction is explicit and paced, so no card exists
    // until the learner introduces a passage — the first via "Start first passage".
    expect(passages.map((passage) => passage.status)).toEqual(["queued", "queued"]);
    expect(passages[0]).toMatchObject({
      anchorStatus: "anchored",
      endBlockEntryId: "block-a",
      endOffset: "The quick brown fox.".length,
      planEntryId: "plan-1",
      reviewCount: 0,
      startBlockEntryId: "block-a",
      startOffset: 0,
      status: "queued"
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

  it("rejects seeding a familiarizing plan (the learner reaches Learning first via Today)", async () => {
    await seedWorkWithBlocks("work-fam", [{ id: "fam-b1", text: "One line." }]);
    const planEntryId = await adopt("work-fam", "familiarizing");

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/passages/seed`
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "wrong_phase" });
    // Nothing was divided — a familiarizing plan never gains passages.
    expect((await listPassages(planEntryId)).passages).toEqual([]);
  });

  it("seeds a maintenance plan's passages as queued (no schedule until a whole-work break)", async () => {
    await seedWorkWithBlocks("work-maint", [
      { id: "maint-b1", text: "First line." },
      { id: "maint-b2", text: "Second line." }
    ]);
    const planEntryId = await adopt("work-maint", "maintenance");

    const seeded = await seedPassages(planEntryId);

    expect(seeded.code).toBe(201);
    // A learner who already knows the Work gets its boundaries laid out, but every passage is queued: no
    // FSRS card, so it adds no passage due work (#605).
    expect(seeded.body.passages.map((passage) => passage.status)).toEqual(["queued", "queued"]);
    expect(seeded.body.passages.every((passage) => passage.reviewCount === 0)).toBe(true);
    const listed = await listPassages(planEntryId);
    expect(listed.passages.map((passage) => passage.status)).toEqual(["queued", "queued"]);
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

  it("schedules a passage review at the 0.95 recitation retention, not the recall default", async () => {
    const { passages } = await seededTwoPassagePlan();
    // The passage card was seeded fresh at `now`; rating it advances from that exact state, so the
    // schedule is deterministic and we can pin it to applyRating at the recitation retention.
    const seededAt = new Date("2026-07-01T09:00:00.000Z");
    const expected = applyRating(
      newReviewState(seededAt),
      "easy",
      seededAt,
      RECITATION_REQUEST_RETENTION
    );
    // The recall default (0.90) would schedule the same rating differently — proving 0.95 is actually
    // fed into the scheduler here, not merely stored on the card.
    const recallBaseline = applyRating(
      newReviewState(seededAt),
      "easy",
      seededAt,
      RECALL_REQUEST_RETENTION
    );
    expect(expected.due).not.toBe(recallBaseline.due);

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "easy" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as RecordRecitationReviewResponse;
    expect(body.passage.dueAt).toBe(expected.due);
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

  it("leaves the predecessor untouched when the lead-in is not marked failed", async () => {
    const { planEntryId, passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "preceding_line", rating: "good" },
      url: `/api/recitation/passages/${passages[1]!.entryId}/review`
    });
    expect(response.statusCode).toBe(200);

    const listed = await listPassages(planEntryId);
    // Only the target (index 1) is graded; the predecessor (index 0) was never introduced, so a
    // non-failed lead-in leaves it untouched — still queued, with no review and no card.
    expect(listed.passages.map((passage) => passage.reviewCount)).toEqual([0, 1]);
    expect(listed.passages[0]!.status).toBe("queued");
  });

  it("applies an Again to the immediate predecessor when the lead-in is marked failed", async () => {
    const { planEntryId, passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "preceding_line", leadInFailed: true, rating: "good" },
      url: `/api/recitation/passages/${passages[1]!.entryId}/review`
    });
    expect(response.statusCode).toBe(200);

    const listed = await listPassages(planEntryId);
    // The target is graded good; the predecessor also gets a review row (the failed lead-in Again).
    expect(listed.passages.map((passage) => passage.reviewCount)).toEqual([1, 1]);
    expect(listed.passages[0]!.reps).toBe(1);
    expect(listed.passages[0]!.lapses).toBe(0);
    expect(listed.passages[0]!.lastReviewedAt).not.toBeNull();
  });

  it("ignores a failed lead-in on the first passage (no predecessor to fail)", async () => {
    const { planEntryId, passages } = await seededTwoPassagePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", leadInFailed: true, rating: "good" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });
    expect(response.statusCode).toBe(200);

    const listed = await listPassages(planEntryId);
    // The first passage has no predecessor, so only the target is graded and nothing else is touched.
    expect(listed.passages.map((passage) => passage.reviewCount)).toEqual([1, 0]);
  });
});

describe("queued maintenance passages (#605)", () => {
  it("splits a queued passage into two queued halves (no schedule is created)", async () => {
    const { passages } = await seededMaintenancePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { atBlockEntryId: "maint-a", atOffset: 4 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { passages: RecitationPassageDto[] };
    expect(body.passages.map((passage) => passage.sourceText)).toEqual([
      "The ",
      "quick brown fox.",
      "Jumps over the lazy dog."
    ]);
    // Editing a queued plan's boundaries never activates a passage — all halves stay queued.
    expect(body.passages.every((passage) => passage.status === "queued")).toBe(true);
  });

  it("merges two queued passages into a single queued passage", async () => {
    const { passages } = await seededMaintenancePlan();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/passages/${passages[0]!.entryId}/merge-next`
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { passages: RecitationPassageDto[] };
    expect(body.passages).toHaveLength(1);
    expect(body.passages[0]!.status).toBe("queued");
  });

  it("activates a queued passage when it is practised directly, starting a fresh schedule", async () => {
    const { passages } = await seededMaintenancePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "good" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });
    expect(response.statusCode).toBe(200);

    const reviewed = (response.json() as RecordRecitationReviewResponse).passage;
    // The queued passage is now a live, scheduled card: an active status, a review count, an FSRS rep.
    expect(reviewed.status).toBe("active");
    expect(reviewed.reviewCount).toBe(1);
    const [row] = await context.db
      .select()
      .from(recitationPassages)
      .where(eq(recitationPassages.entryId, passages[0]!.entryId))
      .limit(1);
    expect(row!.introducedAt).not.toBeNull();
    // Its sibling was not touched, so it stays queued.
    const [sibling] = await context.db
      .select()
      .from(recitationPassages)
      .where(eq(recitationPassages.entryId, passages[1]!.entryId))
      .limit(1);
    expect(sibling!.introducedAt).toBeNull();
  });

  it("activates both the target and a queued predecessor on a failed lead-in", async () => {
    const { planEntryId, passages } = await seededMaintenancePlan();

    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "preceding_line", leadInFailed: true, rating: "good" },
      url: `/api/recitation/passages/${passages[1]!.entryId}/review`
    });
    expect(response.statusCode).toBe(200);

    // The reviewed passage and its previously-queued predecessor are both now active with a review each.
    const listed = await listPassages(planEntryId);
    expect(listed.passages.map((passage) => passage.status)).toEqual(["active", "active"]);
    expect(listed.passages.map((passage) => passage.reviewCount)).toEqual([1, 1]);
  });
});

describe("GET /api/recitation/passages/due", () => {
  it("is null when nothing is due", async () => {
    const due = await loadDue();

    expect(due.passage).toBeNull();
  });

  it("serves the first passage with an opening default cue when its source is unchanged", async () => {
    const { passages } = await seededTwoPassagePlanFirstIntroduced();

    const due = await loadDue();

    expect(due.passage).toMatchObject({
      anchorStatus: "anchored",
      defaultCueStrength: "opening",
      passageEntryId: passages[0]!.entryId,
      precedingText: null,
      supportLevel: "full",
      targetText: "The quick brown fox.",
      workTitle: "The Recitation"
    });
  });

  it("defaults a later passage to a preceding_line cue carrying the previous passage's text", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();
    // Introduce and practise the first passage (pushing it into the future), then introduce the second so
    // it becomes the next due passage.
    await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "easy" },
      url: `/api/recitation/passages/${passages[0]!.entryId}/review`
    });
    expect((await introduceNext(planEntryId)).statusCode).toBe(200);

    const due = await loadDue();

    expect(due.passage).toMatchObject({
      defaultCueStrength: "preceding_line",
      passageEntryId: passages[1]!.entryId,
      precedingText: "The quick brown fox.",
      targetText: "Jumps over the lazy dog."
    });
  });

  it("re-anchors in place when the source text moved within its block", async () => {
    const { passages } = await seededTwoPassagePlanFirstIntroduced();
    await context.db
      .update(docBlocks)
      .set({ plaintext: "PREFIX. The quick brown fox." })
      .where(eq(docBlocks.id, "block-a"));

    const due = await loadDue();

    expect(due.passage).toMatchObject({
      anchorStatus: "anchored",
      targetText: "The quick brown fox."
    });
    const [row] = await context.db
      .select()
      .from(recitationPassages)
      .where(eq(recitationPassages.entryId, passages[0]!.entryId));
    expect(row?.startOffset).toBe("PREFIX. ".length);
  });

  it("drops a plan's due passages from Today once it leaves the learning phase", async () => {
    const { planEntryId } = await seededTwoPassagePlanFirstIntroduced();
    // While learning, the introduced first passage is due immediately.
    expect((await loadDue()).passage).not.toBeNull();

    // Moving the plan on to maintenance retires it from active passage practice: same passages, same due
    // dates, but Today's queue is Learning-only (#578).
    await setPhase(planEntryId, "maintenance");

    expect((await loadDue()).passage).toBeNull();
  });

  it("marks a passage needs_repair when its source can no longer be located", async () => {
    const { passages } = await seededTwoPassagePlanFirstIntroduced();
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

describe("PUT /api/recitation/passages/:id/support-level", () => {
  it("remembers the chosen level so the due passage opens at it", async () => {
    const { passages } = await seededTwoPassagePlanFirstIntroduced();
    expect((await loadDue()).passage?.supportLevel).toBe("full");

    const response = await setSupportLevel(passages[0]!.entryId, "first");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ supportLevel: "first" });

    expect((await loadDue()).passage?.supportLevel).toBe("first");
  });

  it("does not count as a review — the schedule is untouched", async () => {
    const { passages } = await seededTwoPassagePlanFirstIntroduced();

    await setSupportLevel(passages[0]!.entryId, "reduced");

    const after = await loadDue();
    // Same passage still due, no review recorded: changing support level never advances FSRS (#579).
    expect(after.passage?.passageEntryId).toBe(passages[0]!.entryId);
    const [row] = await context.db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, passages[0]!.entryId));
    expect(row?.reps).toBe(0);
    expect(row?.lastReviewedAt).toBeNull();
    // Seeding set the card due at the frozen clock; setting support level leaves that untouched.
    expect(row?.dueAt.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });

  it("resets a split passage's fresh halves back to full support", async () => {
    const { passages } = await seededTwoPassagePlanFirstIntroduced();
    await setSupportLevel(passages[0]!.entryId, "hidden");

    const split = await context.server.inject({
      method: "POST",
      payload: { atBlockEntryId: "block-a", atOffset: 4 },
      url: `/api/recitation/passages/${passages[0]!.entryId}/split`
    });
    expect(split.statusCode).toBe(200);

    // The split halves are fresh passages; the next due one opens at the default full support again.
    expect((await loadDue()).passage?.supportLevel).toBe("full");
  });

  it("is 400 for an unknown support level", async () => {
    const { passages } = await seededTwoPassagePlan();

    const response = await setSupportLevel(passages[0]!.entryId, "peek");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("is 404 for a passage the user does not own", async () => {
    const { passages } = await seededTwoPassagePlan();
    context.setUser(OTHER_USER_ID);

    const response = await setSupportLevel(passages[0]!.entryId, "first");

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/recitation/plans/:id/introduction (#607)", () => {
  it("reports a fresh learning plan as ready to start the first passage", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();

    const status = await getIntroduction(planEntryId);

    expect(status).toMatchObject({
      anyIntroduced: false,
      dailyCap: 3,
      dueCount: 0,
      introducedToday: 0,
      newPassageAvailable: true,
      phase: "learning",
      planEntryId,
      reason: "available",
      remainingCapacity: 3
    });
    // The preview points the "Start first passage" button at the lowest-order queued passage.
    expect(status.nextQueued).toEqual({
      entryId: passages[0]!.entryId,
      orderIndex: 0,
      sourceText: "The quick brown fox."
    });
  });

  it("keeps queued passages out of the due count until they are introduced", async () => {
    const { planEntryId } = await seededTwoPassagePlan();

    // Nothing is due while every passage is queued — queued passages never reach Today.
    expect((await loadDue()).passage).toBeNull();
    expect((await getIntroduction(planEntryId)).dueCount).toBe(0);

    expect((await introduceNext(planEntryId)).statusCode).toBe(200);

    // The introduced passage is due immediately, so it now both appears on Today and counts as due work.
    expect((await loadDue()).passage).not.toBeNull();
    expect((await getIntroduction(planEntryId)).dueCount).toBe(1);
  });

  it("is 404 for a plan the learner does not own", async () => {
    const { planEntryId } = await seededTwoPassagePlan();
    context.setUser(OTHER_USER_ID);

    const response = await context.server.inject({
      method: "GET",
      url: `/api/recitation/plans/${planEntryId}/introduction`
    });

    expect(response.statusCode).toBe(404);
  });

  it("is 404 for an unknown plan id", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/recitation/plans/plan-does-not-exist/introduction"
    });

    expect(response.statusCode).toBe(404);
  });
});

// The set of review cards that exist for a plan's passages — the invariant "one active card per
// introduced passage, none for queued" is what proves introduction never duplicates or skips.
async function cardTargetsForPassages(
  passageEntryIds: ReadonlyArray<string>
): Promise<ReadonlyArray<string>> {
  if (passageEntryIds.length === 0) {
    return [];
  }
  const rows = await context.db
    .select({ targetEntryId: reviewCards.targetEntryId })
    .from(reviewCards);
  return rows.map((row) => row.targetEntryId).filter((target) => passageEntryIds.includes(target));
}

describe("POST /api/recitation/plans/:id/introduce-next (#607)", () => {
  it("introduces the first queued passage, seeding one active card at the 0.95 recitation retention", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();

    const response = await introduceNext(planEntryId);
    expect(response.statusCode).toBe(200);
    const body = response.json() as ActivateNextRecitationPassageResponse;

    // The activated passage is now a live, due card (due at the frozen clock) with no reviews yet.
    expect(body.passage.status).toBe("active");
    expect(body.passage).toMatchObject({
      entryId: passages[0]!.entryId,
      orderIndex: 0,
      reviewCount: 0
    });
    expect(body.passage.status === "active" ? body.passage.dueAt : null).toBe(
      "2026-07-01T09:00:00.000Z"
    );

    // Exactly one card exists — for the introduced passage — and it carries the 0.95 recitation policy.
    const [card] = await context.db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, passages[0]!.entryId));
    expect(card?.requestedRetention).toBe(RECITATION_REQUEST_RETENTION);
    expect(await cardTargetsForPassages(passages.map((passage) => passage.entryId))).toEqual([
      passages[0]!.entryId
    ]);

    // The returned status is the fresh one the client renders: due work now blocks another introduction.
    expect(body.status).toMatchObject({
      anyIntroduced: true,
      dueCount: 1,
      introducedToday: 1,
      newPassageAvailable: false,
      reason: "due_work_remains",
      remainingCapacity: 2
    });
  });

  it("always introduces the lowest-order queued passage, never skipping ahead", async () => {
    const { passages, planEntryId } = await seededLearningPlan(3);

    const first = (
      await introduceNext(planEntryId)
    ).json() as ActivateNextRecitationPassageResponse;
    expect(first.passage.orderIndex).toBe(0);
    await review(passages[0]!.entryId);

    const second = (
      await introduceNext(planEntryId)
    ).json() as ActivateNextRecitationPassageResponse;
    expect(second.passage.orderIndex).toBe(1);
    await review(passages[1]!.entryId);

    const third = (
      await introduceNext(planEntryId)
    ).json() as ActivateNextRecitationPassageResponse;
    expect(third.passage.orderIndex).toBe(2);
  });

  it("refuses to introduce another passage while an introduced one is due", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();
    expect((await introduceNext(planEntryId)).statusCode).toBe(200);

    const second = await introduceNext(planEntryId);

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: "introduction_unavailable",
      reason: "due_work_remains"
    });
    // The second submission changed nothing: the next passage stays queued and owns no card.
    const [sibling] = await context.db
      .select()
      .from(recitationPassages)
      .where(eq(recitationPassages.entryId, passages[1]!.entryId));
    expect(sibling?.introducedAt).toBeNull();
    expect(await cardTargetsForPassages(passages.map((passage) => passage.entryId))).toEqual([
      passages[0]!.entryId
    ]);
  });

  it("is idempotent under double submission — no duplicate card, skipped order, or extra introduction", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();

    const [first, second] = await Promise.all([
      introduceNext(planEntryId),
      introduceNext(planEntryId)
    ]);

    // Exactly one submission activates; the other is rejected — never two cards, never a skipped passage.
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([200, 409]);
    const listed = await listPassages(planEntryId);
    expect(listed.passages.map((passage) => passage.status)).toEqual(["active", "queued"]);
    expect(await cardTargetsForPassages(passages.map((passage) => passage.entryId))).toEqual([
      passages[0]!.entryId
    ]);
    expect((await getIntroduction(planEntryId)).introducedToday).toBe(1);
  });

  it("reaches a calm cap of three introductions in the learner's local day", async () => {
    const { passages, planEntryId } = await seededLearningPlan(4);

    for (const passage of passages.slice(0, RECITATION_DAILY_INTRODUCTION_CAP)) {
      expect((await introduceNext(planEntryId)).statusCode).toBe(200);
      await review(passage.entryId);
    }

    const status = await getIntroduction(planEntryId);
    // Three introduced, none due, one still queued — the cap (not the queue) is what closes the day.
    expect(status).toMatchObject({
      dueCount: 0,
      introducedToday: 3,
      newPassageAvailable: false,
      reason: "cap_reached",
      remainingCapacity: 0
    });
    expect(status.nextQueued).not.toBeNull();

    const fourth = await introduceNext(planEntryId);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toEqual({ error: "introduction_unavailable", reason: "cap_reached" });
  });

  it("reports all passages introduced once the queue is empty", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();
    for (const passage of passages) {
      expect((await introduceNext(planEntryId)).statusCode).toBe(200);
      await review(passage.entryId);
    }

    const status = await getIntroduction(planEntryId);
    expect(status).toMatchObject({
      anyIntroduced: true,
      dueCount: 0,
      introducedToday: 2,
      newPassageAvailable: false,
      reason: "all_introduced",
      remainingCapacity: 1
    });
    expect(status.nextQueued).toBeNull();

    const response = await introduceNext(planEntryId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "introduction_unavailable",
      reason: "all_introduced"
    });
  });

  it("refuses introduction on a maintenance plan (learning phase only)", async () => {
    const { planEntryId } = await seededMaintenancePlan();

    const response = await introduceNext(planEntryId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "introduction_unavailable", reason: "not_learning" });

    const status = await getIntroduction(planEntryId);
    expect(status).toMatchObject({
      newPassageAvailable: false,
      phase: "maintenance",
      reason: "not_learning"
    });
  });

  it("refuses introduction once a plan leaves the learning phase", async () => {
    const { planEntryId } = await seededTwoPassagePlan();
    await setPhase(planEntryId, "maintenance");

    const response = await introduceNext(planEntryId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "introduction_unavailable", reason: "not_learning" });
  });

  it("is 404 for a plan the learner does not own", async () => {
    const { planEntryId } = await seededTwoPassagePlan();
    context.setUser(OTHER_USER_ID);

    const response = await introduceNext(planEntryId);

    expect(response.statusCode).toBe(404);
  });

  it("is 404 for an unknown plan id", async () => {
    const response = await introduceNext("plan-does-not-exist");

    expect(response.statusCode).toBe(404);
  });

  it("is all_introduced for an owned learning plan not yet divided into passages", async () => {
    const workEntryId = "work-unseeded";
    await seedWorkWithBlocks(workEntryId, [{ id: "u-block-a", text: "The quick brown fox." }]);
    const planEntryId = await adopt(workEntryId);
    // The plan is owned but was never seeded, so it has zero passages and nothing to introduce.

    const status = await getIntroduction(planEntryId);
    expect(status).toMatchObject({ anyIntroduced: false, reason: "all_introduced" });
    expect(status.nextQueued).toBeNull();

    const response = await introduceNext(planEntryId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "introduction_unavailable",
      reason: "all_introduced"
    });
  });
});

describe("local-day introduction cap (#606/#607)", () => {
  it("counts introductions by UTC when the learner has no stored zone", async () => {
    const { passages, planEntryId } = await seededTwoPassagePlan();
    // Stamp an introduction at 03:00Z — inside the UTC calendar day of the frozen 09:00Z clock.
    await context.db
      .update(recitationPassages)
      .set({ introducedAt: new Date("2026-07-01T03:00:00.000Z") })
      .where(eq(recitationPassages.entryId, passages[0]!.entryId));

    expect((await getIntroduction(planEntryId)).introducedToday).toBe(1);
  });

  it("excludes an introduction made before the learner's local midnight in a western zone", async () => {
    await setLearnerTimeZone("America/New_York");
    const { passages, planEntryId } = await seededTwoPassagePlan();
    // 03:00Z is 2026-06-30 23:00 in EDT (UTC-4) — the previous local day, so it must not count today,
    // even though it is the same UTC calendar day as the 09:00Z clock. UTC midnight is not authoritative.
    await context.db
      .update(recitationPassages)
      .set({ introducedAt: new Date("2026-07-01T03:00:00.000Z") })
      .where(eq(recitationPassages.entryId, passages[0]!.entryId));

    expect((await getIntroduction(planEntryId)).introducedToday).toBe(0);
  });

  it("resolves the local-day boundary using the zone's daylight-saving offset", async () => {
    await setLearnerTimeZone("America/New_York");
    const { passages, planEntryId } = await seededTwoPassagePlan();
    const stampAt = async (iso: string): Promise<void> => {
      await context.db
        .update(recitationPassages)
        .set({ introducedAt: new Date(iso) })
        .where(eq(recitationPassages.entryId, passages[0]!.entryId));
    };

    // Summer (EDT, UTC-4): local midnight is 04:00Z, so a 04:30Z stamp is inside the current local day.
    context.setNow("2026-07-15T12:00:00.000Z");
    await stampAt("2026-07-15T04:30:00.000Z");
    expect((await getIntroduction(planEntryId)).introducedToday).toBe(1);

    // Winter (EST, UTC-5): local midnight shifts to 05:00Z, so the same 04:30Z wall time is the previous
    // local day — the count flips purely because the DST offset moved the boundary.
    context.setNow("2026-01-15T12:00:00.000Z");
    await stampAt("2026-01-15T04:30:00.000Z");
    expect((await getIntroduction(planEntryId)).introducedToday).toBe(0);
  });
});
