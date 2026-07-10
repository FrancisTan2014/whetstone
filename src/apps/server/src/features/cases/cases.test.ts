import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { cases, domains } from "../../db/schema.js";
import {
  enrollRecallItem,
  recordRecallReview,
  type RecallDependencies
} from "../recall/recallCommands.js";
import { getCaseDetail, listCasesInDomain, listDomains } from "./caseQueries.js";
import { seedCaseCorpus } from "./caseSeed.js";

const userA = "user-a";
const userB = "user-b";
const t0 = new Date("2026-01-01T00:00:00.000Z");

type TestContext = Readonly<{ db: DbClient; recall: RecallDependencies }>;
let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  await seedCaseCorpus(db);
  let sequence = 0;
  return { db, recall: { createId: () => `id-${(sequence += 1)}`, db } };
}

// Enroll a recall item linked to a chunk and drive it to a target FSRS maturity, so a chunk can be
// asserted as new/learning/due/mastered. "due" = just enrolled (due immediately); "learning" = one
// passing review (not due); "mastered" = spaced "easy" reviews at each due date until it graduates to a
// comfortably long interval (state "review", scheduledDays >= 21).
async function practise(
  chunkId: string,
  userId: string,
  maturity: "due" | "learning" | "mastered"
): Promise<void> {
  const item = await enrollRecallItem(
    context.recall,
    { chunkId, kind: "chunk", text: chunkId },
    userId,
    t0
  );
  if (maturity === "due") {
    return;
  }
  if (maturity === "learning") {
    await recordRecallReview(context.recall, item.id, "good", userId, t0);
    return;
  }
  let now = t0;
  for (let i = 0; i < 12; i += 1) {
    const result = await recordRecallReview(context.recall, item.id, "easy", userId, now);
    if (result.status !== "recorded") throw new Error("review failed");
    if (result.item.review.state === "review" && result.item.review.scheduledDays >= 21) return;
    now = new Date(result.item.review.due);
  }
  throw new Error(`chunk ${chunkId} did not reach mastered`);
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("listDomains", () => {
  it("returns the seeded domains in their weighted order", async () => {
    const result = await listDomains(context.db);
    expect(result.length).toBeGreaterThanOrEqual(5);
    expect(result[0]).toEqual({ id: "kitchen", name: "Kitchen & cooking", weight: 0.9 });
  });

  it("seeds idempotently — a second seed adds no duplicates", async () => {
    const before = (await listDomains(context.db)).length;
    await seedCaseCorpus(context.db);
    expect((await listDomains(context.db)).length).toBe(before);
  });
});

describe("listCasesInDomain", () => {
  it("returns a domain's cases in order", async () => {
    const result = await listCasesInDomain(context.db, "kitchen");
    expect(result.map((c) => c.id)).toEqual([
      "kitchen.meal_planning",
      "kitchen.at_the_table",
      "kitchen.cooking_in_progress"
    ]);
    expect(result[0]).toMatchObject({
      communicativeFunction: "Proposing and negotiating a plan",
      domainId: "kitchen"
    });
  });

  it("returns nothing for an unknown domain", async () => {
    expect(await listCasesInDomain(context.db, "nope")).toEqual([]);
  });
});

describe("getCaseDetail", () => {
  it("returns undefined for an unknown case", async () => {
    expect(await getCaseDetail(context.db, "nope", userA, t0)).toBeUndefined();
  });

  it("returns the chunk inventory and an all-new summary before any practice", async () => {
    const detail = await getCaseDetail(context.db, "kitchen.meal_planning", userA, t0);
    if (detail === undefined) {
      throw new Error("expected a case detail");
    }

    expect(detail.case.id).toBe("kitchen.meal_planning");
    expect(detail.chunks[0]?.id).toBe("kitchen.meal_planning.whats_for_dinner");
    expect(detail.chunks).toHaveLength(7);
    expect(detail.mastery).toEqual({
      caseId: "kitchen.meal_planning",
      dueChunks: 0,
      learningChunks: 0,
      masteredChunks: 0,
      newChunks: 7,
      totalChunks: 7
    });
  });

  it("derives the mastery summary from the user's linked recall items", async () => {
    // mastered: graduated and pushed past its due date; learning: one pass, not due; due: just
    // enrolled (due immediately). The remaining chunks stay new.
    await practise("kitchen.meal_planning.whats_for_dinner", userA, "mastered");
    await practise("kitchen.meal_planning.feel_like", userA, "learning");
    await practise("kitchen.meal_planning.how_about", userA, "due");

    const detail = await getCaseDetail(context.db, "kitchen.meal_planning", userA, t0);
    expect(detail?.mastery).toEqual({
      caseId: "kitchen.meal_planning",
      dueChunks: 1,
      learningChunks: 1,
      masteredChunks: 1,
      newChunks: 4,
      totalChunks: 7
    });
  });

  it("never leaks another user's mastery (content shared, mastery user-scoped)", async () => {
    await practise("kitchen.meal_planning.how_about", userB, "mastered");

    const forA = await getCaseDetail(context.db, "kitchen.meal_planning", userA, t0);
    expect(forA?.mastery).toMatchObject({ masteredChunks: 0, newChunks: 7 });

    const forB = await getCaseDetail(context.db, "kitchen.meal_planning", userB, t0);
    expect(forB?.mastery).toMatchObject({ masteredChunks: 1, newChunks: 6 });
  });

  it("aggregates multiple recall items linked to the same chunk", async () => {
    await practise("kitchen.meal_planning.whats_for_dinner", userA, "mastered");
    // A second item linked to the same chunk, still due — the chunk stays "due" (due wins).
    await practise("kitchen.meal_planning.whats_for_dinner", userA, "due");

    const detail = await getCaseDetail(context.db, "kitchen.meal_planning", userA, t0);
    expect(detail?.mastery).toMatchObject({ dueChunks: 1, masteredChunks: 0, newChunks: 6 });
  });

  it("handles a case with no chunks yet", async () => {
    await context.db
      .insert(domains)
      .values({ id: "d-empty", name: "Empty", orderIndex: 99, weight: 0.1 });
    await context.db.insert(cases).values({
      communicativeFunction: "f",
      domainId: "d-empty",
      id: "d-empty.case",
      orderIndex: 0,
      situation: "s"
    });

    const detail = await getCaseDetail(context.db, "d-empty.case", userA, t0);
    expect(detail?.chunks).toEqual([]);
    expect(detail?.mastery).toMatchObject({ newChunks: 0, totalChunks: 0 });
  });
});
