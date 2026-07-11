import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryPromptCardDto, MemoryPromptDto } from "@whetstone/contracts";
import { applyRating, newReviewState } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { memoryPromptReviews, memoryPrompts } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { depositMemory } from "./memoryCommands.js";
import type { MemoryRouteDependencies } from "./memoryRoutes.js";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{
  db: DbClient;
  memory: MemoryRouteDependencies;
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
  const memory: MemoryRouteDependencies = {
    createId: () => `id-${(sequence += 1)}`,
    db,
    now: () => now
  };

  return {
    db,
    memory,
    server: createServer({ logger: false, recall: memory }),
    setNow: (when) => {
      now = when;
    }
  };
}

// Seed one scheduled prompt (cue + answer) whose card is due at `depositedAt`, for the given user.
async function seedScheduled(cueText: string, userId: string, depositedAt: Date): Promise<string> {
  const deposit = await depositMemory(
    context.memory,
    {
      captureSource: "practice",
      noteText: cueText,
      prompts: [{ cueText, answerText: `answer:${cueText}` }]
    },
    userId,
    depositedAt
  );
  return deposit.prompts[0]!.promptId;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

async function getDue(): Promise<ReadonlyArray<MemoryPromptCardDto>> {
  const response = await context.server.inject({ method: "GET", url: "/api/recall/due" });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: ReadonlyArray<MemoryPromptCardDto> }).items;
}

describe("GET /api/recall/due", () => {
  it("lists only the current user's due prompts, soonest first, excluding not-yet-due and other users'", async () => {
    const early = await seedScheduled("early", DEFAULT_USER_ID, at(-2));
    const mid = await seedScheduled("mid", DEFAULT_USER_ID, at(-1));
    await seedScheduled("future", DEFAULT_USER_ID, at(2));
    await seedScheduled("theirs", otherUser, at(-2));

    context.setNow(at(0));
    const items = await getDue();

    expect(items.map((item) => item.promptId)).toEqual([early, mid]);
    expect(items[0]?.answerText).toBe("answer:early");
  });

  it("caps today's batch so a backlog never becomes a wall", async () => {
    for (let index = 0; index < 25; index += 1) {
      await seedScheduled(`due-${index}`, DEFAULT_USER_ID, at(-1));
    }

    context.setNow(at(0));
    expect(await getDue()).toHaveLength(20);
  });

  it("returns an explicit empty list when nothing is due", async () => {
    await seedScheduled("future", DEFAULT_USER_ID, at(5));

    context.setNow(at(0));
    expect(await getDue()).toEqual([]);
  });
});

describe("POST /api/recall/prompts/:id/review", () => {
  it("applies FSRS, persists the advanced card, writes a review row, and returns the updated prompt", async () => {
    const promptId = await seedScheduled("quick", DEFAULT_USER_ID, at(-1));
    const expected = applyRating(newReviewState(at(-1)), "good", at(0));

    context.setNow(at(0));
    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: `/api/recall/prompts/${promptId}/review`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as MemoryPromptDto;
    expect(updated.review).toEqual(expected);
    expect(updated.review?.reps).toBe(1);

    const [row] = await context.db
      .select()
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    expect(row?.reps).toBe(1);
    expect(row?.dueAt?.toISOString()).toBe(expected.due);

    const reviews = await context.db
      .select()
      .from(memoryPromptReviews)
      .where(eq(memoryPromptReviews.promptEntryId, promptId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.rating).toBe("good");

    // A reviewed prompt drops out of today's due batch.
    expect(await getDue()).toEqual([]);
  });

  it("rejects an invalid rating with 400", async () => {
    const promptId = await seedScheduled("quick", DEFAULT_USER_ID, at(-1));

    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "perfect" },
      url: `/api/recall/prompts/${promptId}/review`
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a missing prompt", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: "/api/recall/prompts/nope/review"
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/recall/prompts/:id/snooze", () => {
  it("defers the prompt out of today's batch by moving only its due date", async () => {
    const promptId = await seedScheduled("later", DEFAULT_USER_ID, at(-1));

    context.setNow(at(0));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/recall/prompts/${promptId}/snooze`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as MemoryPromptDto;
    expect(updated.review).toEqual({ ...newReviewState(at(-1)), due: at(1).toISOString() });

    const reviews = await context.db
      .select()
      .from(memoryPromptReviews)
      .where(eq(memoryPromptReviews.promptEntryId, promptId));
    expect(reviews).toHaveLength(0);
    expect(await getDue()).toEqual([]);
  });

  it("returns 404 for a missing prompt", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/recall/prompts/nope/snooze"
    });

    expect(response.statusCode).toBe(404);
  });
});
