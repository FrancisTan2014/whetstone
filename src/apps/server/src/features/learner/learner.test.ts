import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ErrorCategory } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { errorPatterns, turnOutcomes } from "../../db/schema.js";
import { seedCaseCorpus } from "../cases/caseSeed.js";
import { enrollRecallItem, recordRecallReview } from "../recall/recallCommands.js";
import {
  defaultProfileSummary,
  depositTurnOutcome,
  updateLearnerProfile,
  type LearnerDependencies
} from "./learnerCommands.js";
import {
  compileContext,
  getLearnerProfile,
  listErrorPatterns,
  listRecentOutcomes
} from "./learnerQueries.js";

const userA = "user-a";
const userB = "user-b";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date(t0.getTime() + day);

type TestContext = Readonly<{ db: DbClient; deps: LearnerDependencies }>;
let context: TestContext;

async function buildContext(seed = true): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  if (seed) {
    await seedCaseCorpus(db);
  }
  let sequence = 0;
  return { db, deps: { createId: () => `id-${(sequence += 1)}`, db } };
}

// Drive a chunk into "mastered" (enroll + three passing reviews) so it counts toward a domain strength.
async function master(chunkId: string, userId: string): Promise<void> {
  const item = await enrollRecallItem(
    context.deps,
    { chunkId, kind: "chunk", text: chunkId },
    userId,
    t0
  );
  for (let i = 0; i < 3; i += 1) {
    await recordRecallReview(context.deps, item.id, 4, userId, t0);
  }
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("depositTurnOutcome", () => {
  it("appends an outcome and creates no error pattern when none is diagnosed", async () => {
    const outcome = await depositTurnOutcome(context.deps, { grade: 4 }, userA, t0);

    expect(outcome).toEqual({
      chunkId: null,
      errorCategory: null,
      grade: 4,
      recordedAt: t0.toISOString()
    });
    expect(
      await context.db.select().from(turnOutcomes).where(eq(turnOutcomes.userId, userA))
    ).toHaveLength(1);
    expect(await listErrorPatterns(context.db, userA, 5)).toEqual([]);
  });

  it("keeps a chunk link on the outcome", async () => {
    const outcome = await depositTurnOutcome(
      context.deps,
      { chunkId: "kitchen.meal_planning.whats_for_dinner", grade: 3 },
      userA,
      t0
    );
    expect(outcome.chunkId).toBe("kitchen.meal_planning.whats_for_dinner");
  });

  it("increments an error pattern's frequency and recency across deposits", async () => {
    await depositTurnOutcome(context.deps, { errorCategory: "article_drop", grade: 2 }, userA, t0);
    await depositTurnOutcome(context.deps, { errorCategory: "article_drop", grade: 2 }, userA, t1);

    expect(await listErrorPatterns(context.db, userA, 5)).toEqual([
      { category: "article_drop", count: 2, lastSeenAt: t1.toISOString() }
    ]);
  });

  it("keeps each user's outcomes and error patterns isolated", async () => {
    await depositTurnOutcome(context.deps, { errorCategory: "article_drop", grade: 1 }, userA, t0);
    await depositTurnOutcome(context.deps, { errorCategory: "register", grade: 1 }, userB, t0);

    expect((await listErrorPatterns(context.db, userA, 5)).map((p) => p.category)).toEqual([
      "article_drop"
    ]);
    expect(
      await context.db.select().from(errorPatterns).where(eq(errorPatterns.userId, userB))
    ).toHaveLength(1);
    expect(await listRecentOutcomes(context.db, userB, 10)).toHaveLength(1);
  });
});

describe("updateLearnerProfile", () => {
  it("distills a beginner profile from a fresh learner", async () => {
    const profile = await updateLearnerProfile(context.deps, userA, t0);

    expect(profile.level).toBe("beginner");
    expect(profile.strengths).toEqual([]);
    expect(profile.weaknesses).toEqual([]);
    expect(profile.focus.startsWith("kitchen.")).toBe(true);
    expect(profile.summary).toContain("beginner");
    expect(await getLearnerProfile(context.db, userA)).toEqual(profile);
  });

  it("reflects mastered domains as strengths and recurring errors as weaknesses", async () => {
    await master("kitchen.meal_planning.whats_for_dinner", userA);
    await master("kitchen.meal_planning.feel_like", userA);
    await master("small_talk.greetings.hows_it_going", userA);
    await master("chores.dividing_up.my_turn", userA);
    await depositTurnOutcome(context.deps, { errorCategory: "article_drop", grade: 1 }, userA, t0);
    await depositTurnOutcome(context.deps, { errorCategory: "article_drop", grade: 1 }, userA, t0);
    await depositTurnOutcome(context.deps, { errorCategory: "register", grade: 1 }, userA, t0);

    const profile = await updateLearnerProfile(context.deps, userA, t0);

    expect(profile.strengths).toEqual(["Kitchen & cooking", "Household chores", "Small talk"]);
    expect(profile.weaknesses).toEqual(["article_drop", "register"]);
  });

  it("delegates summary phrasing to an injected phraser", async () => {
    const profile = await updateLearnerProfile(
      context.deps,
      userA,
      t0,
      (signals) => `FAKE:${signals.level}`
    );
    expect(profile.summary).toBe("FAKE:beginner");
  });

  it("is idempotent for the same model and time", async () => {
    const first = await updateLearnerProfile(context.deps, userA, t0);
    const second = await updateLearnerProfile(context.deps, userA, t0);
    expect(second).toEqual(first);
  });

  it("distills an empty profile when there is no corpus", async () => {
    const empty = await buildContext(false);
    try {
      const profile = await updateLearnerProfile(empty.deps, userA, t0);
      expect(profile).toMatchObject({
        focus: "",
        level: "beginner",
        strengths: [],
        weaknesses: []
      });
      expect(profile.summary).toBe(
        defaultProfileSummary({ focus: "", level: "beginner", strengths: [], weaknesses: [] })
      );
      expect(profile.summary).toContain("nothing queued");
    } finally {
      await empty.db.$client.close();
    }
  });
});

describe("compileContext", () => {
  it("ranks high-gap high-frequency chunks first", async () => {
    const compiled = await compileContext(context.db, userA, t0);

    expect(compiled.rankedChunks[0]).toMatchObject({
      domainId: "kitchen",
      gap: 1,
      score: 0.9,
      status: "new"
    });
    expect(compiled.profile).toBeNull();
  });

  it("aggregates multiple recall items linked to one chunk", async () => {
    await enrollRecallItem(
      context.deps,
      { chunkId: "kitchen.meal_planning.whats_for_dinner", kind: "chunk", text: "a" },
      userA,
      t0
    );
    await enrollRecallItem(
      context.deps,
      { chunkId: "kitchen.meal_planning.whats_for_dinner", kind: "chunk", text: "b" },
      userA,
      t0
    );

    const compiled = await compileContext(context.db, userA, t0, { chunkLimit: 100 });
    const entry = compiled.rankedChunks.find(
      (chunk) => chunk.chunkId === "kitchen.meal_planning.whats_for_dinner"
    );
    // Two just-enrolled items are both due, so the chunk reads as "due".
    expect(entry?.status).toBe("due");
  });

  it("stays bounded in size as history grows", async () => {
    const categories: ReadonlyArray<ErrorCategory> = [
      "article_drop",
      "l1_calque",
      "wrong_collocation",
      "register",
      "word_order",
      "tense_aspect",
      "other"
    ];
    for (let i = 0; i < 40; i += 1) {
      await depositTurnOutcome(
        context.deps,
        { errorCategory: categories[i % categories.length], grade: i % 6 },
        userA,
        new Date(t0.getTime() + i * 1000)
      );
    }

    const compiled = await compileContext(context.db, userA, t0);
    expect(compiled.rankedChunks).toHaveLength(10);
    expect(compiled.recentOutcomes).toHaveLength(10);
    expect(compiled.relevantErrors).toHaveLength(5);

    // Twice the history -> the same bounded shape.
    for (let i = 0; i < 40; i += 1) {
      await depositTurnOutcome(context.deps, { errorCategory: "other", grade: 1 }, userA, t1);
    }
    const again = await compileContext(context.db, userA, t0);
    expect(again.rankedChunks).toHaveLength(10);
    expect(again.recentOutcomes).toHaveLength(10);
    expect(again.relevantErrors).toHaveLength(5);
  });

  it("honours custom caps", async () => {
    await depositTurnOutcome(context.deps, { errorCategory: "register", grade: 1 }, userA, t0);

    const compiled = await compileContext(context.db, userA, t0, {
      chunkLimit: 3,
      errorLimit: 1,
      outcomeLimit: 1
    });
    expect(compiled.rankedChunks).toHaveLength(3);
    expect(compiled.recentOutcomes).toHaveLength(1);
    expect(compiled.relevantErrors).toHaveLength(1);
  });

  it("includes the profile once it has been distilled", async () => {
    const profile = await updateLearnerProfile(context.deps, userA, t0);
    const compiled = await compileContext(context.db, userA, t0);
    expect(compiled.profile).toEqual(profile);
  });

  it("never leaks another user's outcomes or errors", async () => {
    await depositTurnOutcome(context.deps, { errorCategory: "register", grade: 1 }, userB, t0);
    await master("kitchen.meal_planning.whats_for_dinner", userB);

    const compiled = await compileContext(context.db, userA, t0);
    expect(compiled.recentOutcomes).toEqual([]);
    expect(compiled.relevantErrors).toEqual([]);
    // userB mastered a kitchen chunk, but for userA every chunk is still new.
    expect(compiled.rankedChunks.every((chunk) => chunk.status === "new")).toBe(true);
  });
});
