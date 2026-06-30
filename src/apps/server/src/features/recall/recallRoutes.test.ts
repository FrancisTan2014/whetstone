import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnrollRecallItemRequest, RecallItemDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { recallItems, recallReviews } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { enrollRecallItem } from "./recallCommands.js";
import type { RecallRouteDependencies } from "./recallRoutes.js";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{
  db: DbClient;
  recall: RecallRouteDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (when: Date) => void;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = t0;
  let sequence = 0;
  const recall: RecallRouteDependencies = {
    createId: () => `id-${(sequence += 1)}`,
    db,
    now: () => now
  };

  return {
    db,
    recall,
    server: createServer({ logger: false, recall }),
    setNow: (when) => {
      now = when;
    }
  };
}

// Seed an item for a user via the real enroll path; `enrolledAt` becomes its initial due time.
function seed(
  request: EnrollRecallItemRequest,
  userId: string,
  enrolledAt: Date
): Promise<RecallItemDto> {
  return enrollRecallItem(context.recall, request, userId, enrolledAt);
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

async function getDue(): Promise<ReadonlyArray<RecallItemDto>> {
  const response = await context.server.inject({ method: "GET", url: "/api/recall/due" });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: ReadonlyArray<RecallItemDto> }).items;
}

describe("GET /api/recall/due", () => {
  it("lists only the current user's due items, soonest first, excluding not-yet-due and other users'", async () => {
    const early = await seed({ kind: "word", text: "early" }, DEFAULT_USER_ID, at(-2));
    const mid = await seed({ kind: "word", text: "mid" }, DEFAULT_USER_ID, at(-1));
    await seed({ kind: "word", text: "future" }, DEFAULT_USER_ID, at(2));
    await seed({ kind: "word", text: "theirs" }, otherUser, at(-2));

    context.setNow(at(0));
    const items = await getDue();

    expect(items.map((item) => item.id)).toEqual([early.id, mid.id]);
  });

  it("caps today's batch so a backlog never becomes a wall", async () => {
    for (let index = 0; index < 25; index += 1) {
      await seed({ kind: "word", text: `due-${index}` }, DEFAULT_USER_ID, at(-1));
    }

    context.setNow(at(0));
    const items = await getDue();

    expect(items).toHaveLength(20);
  });

  it("returns an explicit empty list when nothing is due", async () => {
    await seed({ kind: "word", text: "future" }, DEFAULT_USER_ID, at(5));

    context.setNow(at(0));
    expect(await getDue()).toEqual([]);
  });
});

describe("POST /api/recall/items/:id/review", () => {
  it("applies SM-2, persists the advanced state, writes a review row, and returns the updated item", async () => {
    const item = await seed({ kind: "word", text: "quick" }, DEFAULT_USER_ID, at(-1));

    context.setNow(at(0));
    const response = await context.server.inject({
      method: "POST",
      payload: { grade: 4 },
      url: `/api/recall/items/${item.id}/review`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as RecallItemDto;
    expect(updated.review).toMatchObject({ intervalDays: 1, lapses: 0, repetitions: 1 });
    expect(updated.review.dueAt).toBe(at(1).toISOString());

    const [row] = await context.db.select().from(recallItems).where(eq(recallItems.id, item.id));
    expect(row?.intervalDays).toBe(1);
    expect(row?.repetitions).toBe(1);
    expect(row?.dueAt.toISOString()).toBe(at(1).toISOString());

    const reviews = await context.db
      .select()
      .from(recallReviews)
      .where(eq(recallReviews.recallItemId, item.id));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.grade).toBe(4);

    // A reviewed item drops out of today's due batch.
    expect(await getDue()).toEqual([]);
  });

  it("rejects an invalid body with 400", async () => {
    const item = await seed({ kind: "word", text: "quick" }, DEFAULT_USER_ID, at(-1));

    const response = await context.server.inject({
      method: "POST",
      payload: { grade: 9 },
      url: `/api/recall/items/${item.id}/review`
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a missing item", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { grade: 4 },
      url: "/api/recall/items/nope/review"
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another user's item and leaves it unchanged", async () => {
    const item = await seed({ kind: "word", text: "theirs" }, otherUser, at(-1));

    const response = await context.server.inject({
      method: "POST",
      payload: { grade: 4 },
      url: `/api/recall/items/${item.id}/review`
    });
    expect(response.statusCode).toBe(404);

    const [row] = await context.db.select().from(recallItems).where(eq(recallItems.id, item.id));
    expect(row?.repetitions).toBe(0);
  });
});

describe("POST /api/recall/items/:id/snooze", () => {
  it("defers the item out of today's batch by moving only its due date, leaving SM-2 state unchanged", async () => {
    const item = await seed({ kind: "word", text: "later" }, DEFAULT_USER_ID, at(-1));

    context.setNow(at(0));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/recall/items/${item.id}/snooze`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as RecallItemDto;
    expect(updated.review.dueAt).toBe(at(1).toISOString());
    // Snooze is not a grade: the schedule counters are untouched.
    expect(updated.review).toMatchObject({
      easeFactor: 2.5,
      intervalDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      repetitions: 0
    });

    // No review row was written, and the item is no longer due today.
    const reviews = await context.db
      .select()
      .from(recallReviews)
      .where(eq(recallReviews.recallItemId, item.id));
    expect(reviews).toHaveLength(0);
    expect(await getDue()).toEqual([]);
  });

  it("returns 404 for a missing item", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/recall/items/nope/snooze"
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another user's item", async () => {
    const item = await seed({ kind: "word", text: "theirs" }, otherUser, at(-1));

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recall/items/${item.id}/snooze`
    });

    expect(response.statusCode).toBe(404);
  });
});
