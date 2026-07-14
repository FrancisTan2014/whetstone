import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  RecitationChainingResponse,
  RecitationChainResponse,
  RecitationPhaseDto,
  RecitationTodayResponse,
  SessionRecallOutcomeDto,
  WholeWorkResponse
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  readingUnits,
  recitationChains,
  recitationPassages,
  recitationReviews,
  workMeta
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { RecitationRouteDependencies } from "../recitation/recitationRoutes.js";
import type { RecitationChainingRouteDependencies } from "./recitationChainingRoutes.js";
import type { RecitationPassageRouteDependencies } from "./recitationPassageRoutes.js";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const START = "2026-07-01T09:00:00.000Z";

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

  let now = new Date(START);
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
  const recitationChaining: RecitationChainingRouteDependencies = {
    createId: () => `chain-${(sequence += 1)}`,
    db,
    now: () => now
  };

  return {
    db,
    server: createServer({
      currentUser: { getCurrentUserId: () => userId },
      logger: false,
      recitation,
      recitationChaining,
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

async function adopt(workEntryId: string, phase: RecitationPhaseDto = "learning"): Promise<string> {
  const response = await context.server.inject({
    method: "POST",
    payload: { phase, workEntryId },
    url: "/api/recitation/plans"
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { entryId: string }).entryId;
}

// Seed N single-block passages for a fresh plan and return their ids in reciting order.
async function seedPlan(
  workEntryId: string,
  texts: readonly string[]
): Promise<{ planEntryId: string; passageIds: string[] }> {
  await seedWorkWithBlocks(
    workEntryId,
    texts.map((text, index) => ({ id: `${workEntryId}-b${index}`, text }))
  );
  const planEntryId = await adopt(workEntryId);
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

// Seed a maintenance plan: the learner already knows the Work, so its passages are laid out as queued
// (no schedule, no due work) and whole-work upkeep is eligible immediately (#605).
async function seedMaintenancePlan(
  workEntryId: string,
  texts: readonly string[]
): Promise<{ planEntryId: string; passageIds: string[] }> {
  await seedWorkWithBlocks(
    workEntryId,
    texts.map((text, index) => ({ id: `${workEntryId}-b${index}`, text }))
  );
  const planEntryId = await adopt(workEntryId, "maintenance");
  const seeded = await context.server.inject({
    method: "POST",
    url: `/api/recitation/plans/${planEntryId}/passages/seed`
  });
  expect(seeded.statusCode).toBe(201);
  const passages = (
    seeded.json() as { passages: ReadonlyArray<{ entryId: string; status: string }> }
  ).passages;
  expect(passages.every((passage) => passage.status === "queued")).toBe(true);
  return { passageIds: passages.map((passage) => passage.entryId), planEntryId };
}

// Record `count` Good reviews on a passage at the current clock, making it owned once count >= 2 (and
// retrievability is still high because we do not advance the clock).
async function ownPassage(passageEntryId: string, count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const response = await context.server.inject({
      method: "POST",
      payload: { cueStrength: "opening", rating: "good" },
      url: `/api/recitation/passages/${passageEntryId}/review`
    });
    expect(response.statusCode).toBe(200);
  }
}

async function getChaining(planEntryId: string): Promise<RecitationChainingResponse["chaining"]> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/recitation/plans/${planEntryId}/chaining`
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as RecitationChainingResponse).chaining;
}

async function startChain(
  planEntryId: string,
  endOrderIndex: number
): Promise<ReturnType<TestContext["server"]["inject"]>> {
  return context.server.inject({
    method: "POST",
    payload: { endOrderIndex },
    url: `/api/recitation/plans/${planEntryId}/chain`
  });
}

async function completeChain(
  chainId: string,
  outcome: SessionRecallOutcomeDto
): Promise<ReturnType<TestContext["server"]["inject"]>> {
  return context.server.inject({
    method: "POST",
    payload: { outcome },
    url: `/api/recitation/chains/${chainId}/complete`
  });
}

async function reviewWholeWork(
  planEntryId: string,
  rating: string,
  outcome: SessionRecallOutcomeDto
): Promise<ReturnType<TestContext["server"]["inject"]>> {
  return context.server.inject({
    method: "POST",
    payload: { outcome, rating },
    url: `/api/recitation/plans/${planEntryId}/whole-work/review`
  });
}

async function getToday(): Promise<RecitationTodayResponse["today"]> {
  const response = await context.server.inject({ method: "GET", url: "/api/recitation/today" });
  expect(response.statusCode).toBe(200);
  return (response.json() as RecitationTodayResponse).today;
}

async function passageRow(passageEntryId: string): Promise<typeof recitationPassages.$inferSelect> {
  const [row] = await context.db
    .select()
    .from(recitationPassages)
    .where(eq(recitationPassages.entryId, passageEntryId))
    .limit(1);
  return row!;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("GET /api/recitation/plans/:id/chaining", () => {
  it("reports an empty owned prefix and no eligibility for an un-reviewed plan", async () => {
    const { planEntryId } = await seedPlan("work-1", ["Line one.", "Line two."]);

    const chaining = await getChaining(planEntryId);

    expect(chaining.ownedPrefix).toEqual({ ownedCount: 0, total: 2 });
    expect(chaining.chainEligibility).toEqual({ status: "not_eligible" });
    expect(chaining.activeChain).toBeNull();
    expect(chaining.wholeWork).toEqual({ due: false, dueAt: null, exists: false });
    expect(chaining.wholeWorkOwned).toBe(false);
  });

  it("grows the owned prefix contiguously and offers a chain once two adjacent passages are owned", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two.", "Three."]);

    await ownPassage(passageIds[0]!);
    expect((await getChaining(planEntryId)).ownedPrefix).toEqual({ ownedCount: 1, total: 3 });
    expect((await getChaining(planEntryId)).chainEligibility).toEqual({ status: "not_eligible" });

    await ownPassage(passageIds[1]!);
    const chaining = await getChaining(planEntryId);
    expect(chaining.ownedPrefix).toEqual({ ownedCount: 2, total: 3 });
    expect(chaining.chainEligibility).toEqual({ maxEndIndex: 1, status: "eligible" });
    expect(chaining.wholeWorkOwned).toBe(false);
  });

  it("does not count a disconnected later island of mastery as progress", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two.", "Three."]);

    // Own the first and the third, leaving a gap at the second.
    await ownPassage(passageIds[0]!);
    await ownPassage(passageIds[2]!);

    const chaining = await getChaining(planEntryId);
    expect(chaining.ownedPrefix).toEqual({ ownedCount: 1, total: 3 });
    expect(chaining.chainEligibility).toEqual({ status: "not_eligible" });
  });

  it("drops a passage out of the owned prefix as its retrievability decays over time", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await ownPassage(passageIds[0]!);
    await ownPassage(passageIds[1]!);
    expect((await getChaining(planEntryId)).ownedPrefix.ownedCount).toBe(2);

    // Far in the future the passages are no longer retained, so ownership lapses (not a permanent badge).
    context.setNow("2027-07-01T09:00:00.000Z");
    expect((await getChaining(planEntryId)).ownedPrefix.ownedCount).toBe(0);
  });

  it("reports an empty owned prefix for an adopted plan that has no passages yet", async () => {
    await seedWorkWithBlocks("work-1", [{ id: "work-1-b0", text: "One." }]);
    const planEntryId = await adopt("work-1");

    const chaining = await getChaining(planEntryId);
    expect(chaining.ownedPrefix).toEqual({ ownedCount: 0, total: 0 });
    expect(chaining.chainEligibility).toEqual({ status: "not_eligible" });
    expect(chaining.wholeWorkOwned).toBe(false);
    expect(chaining.wholeWork).toEqual({ due: false, dueAt: null, exists: false });
  });

  it("is 404 for another user's plan and for an unknown plan", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    context.setUser(OTHER_USER_ID);
    const foreign = await context.server.inject({
      method: "GET",
      url: `/api/recitation/plans/${planEntryId}/chaining`
    });
    expect(foreign.statusCode).toBe(404);

    context.setUser(DEFAULT_USER_ID);
    const missing = await context.server.inject({
      method: "GET",
      url: "/api/recitation/plans/nope/chaining"
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/recitation/plans/:id/chain", () => {
  async function ownedPairPlan(): Promise<{ planEntryId: string; passageIds: string[] }> {
    const plan = await seedPlan("work-1", ["One.", "Two.", "Three."]);
    await ownPassage(plan.passageIds[0]!);
    await ownPassage(plan.passageIds[1]!);
    return plan;
  }

  it("starts a contiguous chain over the owned prefix and persists it as active", async () => {
    const { planEntryId, passageIds } = await ownedPairPlan();

    const response = await startChain(planEntryId, 1);
    expect(response.statusCode).toBe(201);
    const { chain } = response.json() as RecitationChainResponse;
    expect(chain.endOrderIndex).toBe(1);
    expect(chain.status).toBe("active");
    expect(chain.passages.map((passage) => passage.passageEntryId)).toEqual([
      passageIds[0],
      passageIds[1]
    ]);
    expect(chain.passages.map((passage) => passage.orderIndex)).toEqual([0, 1]);

    const chaining = await getChaining(planEntryId);
    expect(chaining.activeChain?.chainId).toBe(chain.chainId);
  });

  it("rejects a chain shorter than two passages, out of range, or beyond the owned prefix", async () => {
    const { planEntryId } = await ownedPairPlan();

    const tooShort = await startChain(planEntryId, 0);
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json()).toEqual({ error: "invalid_chain", reason: "too_short" });

    const outOfRange = await startChain(planEntryId, 9);
    expect(outOfRange.json()).toEqual({ error: "invalid_chain", reason: "out_of_range" });

    // Passage index 2 exists but is not owned (only [0,1] are), so it lies beyond the owned prefix.
    const notOwned = await startChain(planEntryId, 2);
    expect(notOwned.json()).toEqual({ error: "invalid_chain", reason: "not_owned" });
  });

  it("replaces any prior active chain so at most one is active per plan", async () => {
    const { planEntryId } = await ownedPairPlan();

    await startChain(planEntryId, 1);
    await startChain(planEntryId, 1);

    const active = await context.db
      .select()
      .from(recitationChains)
      .where(
        and(eq(recitationChains.planEntryId, planEntryId), eq(recitationChains.status, "active"))
      );
    expect(active).toHaveLength(1);
  });

  it("is 400 for a malformed body and 404 for a plan the user does not own", async () => {
    const { planEntryId } = await ownedPairPlan();

    const malformed = await context.server.inject({
      method: "POST",
      payload: { endOrderIndex: "two" },
      url: `/api/recitation/plans/${planEntryId}/chain`
    });
    expect(malformed.statusCode).toBe(400);

    context.setUser(OTHER_USER_ID);
    const foreign = await startChain(planEntryId, 1);
    expect(foreign.statusCode).toBe(404);
  });
});

describe("POST /api/recitation/chains/:id/complete", () => {
  async function startedChain(): Promise<{ chainId: string; passageIds: string[] }> {
    const plan = await seedPlan("work-1", ["One.", "Two."]);
    await ownPassage(plan.passageIds[0]!);
    await ownPassage(plan.passageIds[1]!);
    const started = await startChain(plan.planEntryId, 1);
    return {
      chainId: (started.json() as RecitationChainResponse).chain.chainId,
      passageIds: plan.passageIds
    };
  }

  it("completes a held run without rating any passage", async () => {
    const { chainId, passageIds } = await startedChain();
    const before = await passageRow(passageIds[1]!);

    const response = await completeChain(chainId, { status: "held" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as RecitationChainResponse).chain.status).toBe("completed");

    const after = await passageRow(passageIds[1]!);
    expect(after.reps).toBe(before.reps);
    expect(after.dueAt.toISOString()).toBe(before.dueAt.toISOString());
  });

  it("applies an Again only to the explicitly identified broken passage", async () => {
    const { chainId, passageIds } = await startedChain();
    const untouchedBefore = await passageRow(passageIds[0]!);

    const response = await completeChain(chainId, {
      passageEntryId: passageIds[1]!,
      status: "broke"
    });
    expect(response.statusCode).toBe(200);

    const broken = await passageRow(passageIds[1]!);
    expect(broken.lapses).toBe(1);
    const againRows = await context.db
      .select()
      .from(recitationReviews)
      .where(
        and(
          eq(recitationReviews.passageEntryId, passageIds[1]!),
          eq(recitationReviews.rating, "again")
        )
      );
    expect(againRows).toHaveLength(1);

    const untouched = await passageRow(passageIds[0]!);
    expect(untouched.reps).toBe(untouchedBefore.reps);
    expect(untouched.lapses).toBe(untouchedBefore.lapses);
  });

  it("rejects an outcome naming a passage outside the chain", async () => {
    const { chainId } = await startedChain();

    const response = await completeChain(chainId, {
      passageEntryId: "not-in-this-chain",
      status: "broke"
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_outcome", reason: "passage_not_in_session" });
  });

  it("is 409 for an already-completed chain and 404 for another user's chain", async () => {
    const { chainId } = await startedChain();
    expect((await completeChain(chainId, { status: "held" })).statusCode).toBe(200);

    const again = await completeChain(chainId, { status: "held" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "not_active" });

    context.setUser(OTHER_USER_ID);
    const foreign = await completeChain(chainId, { status: "held" });
    expect(foreign.statusCode).toBe(404);
  });

  it("is 400 for a malformed body", async () => {
    const { chainId } = await startedChain();
    const response = await context.server.inject({
      method: "POST",
      payload: { outcome: { status: "unknown" } },
      url: `/api/recitation/chains/${chainId}/complete`
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/recitation/plans/:id/whole-work/review", () => {
  async function fullyOwnedPlan(): Promise<{ planEntryId: string; passageIds: string[] }> {
    const plan = await seedPlan("work-1", ["One.", "Two."]);
    await ownPassage(plan.passageIds[0]!);
    await ownPassage(plan.passageIds[1]!);
    return plan;
  }

  it("offers whole-work maintenance once every passage is owned", async () => {
    const { planEntryId } = await fullyOwnedPlan();
    const chaining = await getChaining(planEntryId);
    expect(chaining.wholeWorkOwned).toBe(true);
    expect(chaining.wholeWork).toEqual({ due: true, dueAt: null, exists: false });
  });

  it("is 409 not_eligible when the Work is not fully owned and never reviewed", async () => {
    const plan = await seedPlan("work-1", ["One.", "Two."]);
    await ownPassage(plan.passageIds[0]!);

    const response = await reviewWholeWork(plan.planEntryId, "good", { status: "held" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not_eligible" });
  });

  it("creates a separate aggregate card and schedules it forward on a good review", async () => {
    const { planEntryId } = await fullyOwnedPlan();

    const response = await reviewWholeWork(planEntryId, "good", { status: "held" });
    expect(response.statusCode).toBe(200);
    const { wholeWork } = response.json() as WholeWorkResponse;
    expect(wholeWork.exists).toBe(true);
    expect(wholeWork.due).toBe(false);
    expect(new Date(wholeWork.dueAt!).getTime()).toBeGreaterThan(new Date(START).getTime());

    expect((await getChaining(planEntryId)).wholeWork.exists).toBe(true);
  });

  it("reschedules only the aggregate prompt on a lapse — passages are never reset", async () => {
    const { planEntryId, passageIds } = await fullyOwnedPlan();
    await reviewWholeWork(planEntryId, "good", { status: "held" });
    const passageBefore = await passageRow(passageIds[0]!);

    const response = await reviewWholeWork(planEntryId, "again", { status: "held" });
    expect(response.statusCode).toBe(200);

    const passageAfter = await passageRow(passageIds[0]!);
    expect(passageAfter.reps).toBe(passageBefore.reps);
    expect(passageAfter.lapses).toBe(passageBefore.lapses);
    expect(passageAfter.dueAt.toISOString()).toBe(passageBefore.dueAt.toISOString());
  });

  it("applies an Again only to the identified broken passage during a whole-work reveal", async () => {
    const { planEntryId, passageIds } = await fullyOwnedPlan();
    const untouchedBefore = await passageRow(passageIds[1]!);

    const response = await reviewWholeWork(planEntryId, "good", {
      passageEntryId: passageIds[0]!,
      status: "broke"
    });
    expect(response.statusCode).toBe(200);

    expect((await passageRow(passageIds[0]!)).lapses).toBe(1);
    expect((await passageRow(passageIds[1]!)).lapses).toBe(untouchedBefore.lapses);
  });

  it("rejects an outcome naming a passage outside the Work", async () => {
    const { planEntryId } = await fullyOwnedPlan();
    const response = await reviewWholeWork(planEntryId, "good", {
      passageEntryId: "foreign",
      status: "broke"
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_outcome", reason: "passage_not_in_session" });
  });

  it("is 400 for a malformed body and 404 for a plan the user does not own", async () => {
    const { planEntryId } = await fullyOwnedPlan();
    const malformed = await context.server.inject({
      method: "POST",
      payload: { outcome: { status: "held" } },
      url: `/api/recitation/plans/${planEntryId}/whole-work/review`
    });
    expect(malformed.statusCode).toBe(400);

    context.setUser(OTHER_USER_ID);
    const foreign = await reviewWholeWork(planEntryId, "good", { status: "held" });
    expect(foreign.statusCode).toBe(404);
  });
});

describe("maintenance whole-work upkeep (#605)", () => {
  it("offers whole-work maintenance from queued passages without owning any of them", async () => {
    const { planEntryId } = await seedMaintenancePlan("work-m", ["One.", "Two."]);

    const chaining = await getChaining(planEntryId);
    // Eligible to start upkeep (>=1 anchored passage), yet no passage is owned — the learner never
    // earned them through Learning.
    expect(chaining.wholeWork).toEqual({ due: true, dueAt: null, exists: false });
    expect(chaining.wholeWorkOwned).toBe(false);
    expect(chaining.ownedPrefix).toEqual({ ownedCount: 0, total: 2 });
  });

  it("is not eligible when a maintenance plan has only unanchored (needs_repair) passages", async () => {
    const { planEntryId, passageIds } = await seedMaintenancePlan("work-m", ["One.", "Two."]);
    for (const passageEntryId of passageIds) {
      await context.db
        .update(recitationPassages)
        .set({ anchorStatus: "needs_repair" })
        .where(eq(recitationPassages.entryId, passageEntryId));
    }

    expect((await getChaining(planEntryId)).wholeWork.due).toBe(false);
    const response = await reviewWholeWork(planEntryId, "good", { status: "held" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not_eligible" });
  });

  it("starts the aggregate card on a held review, leaving every passage queued", async () => {
    const { planEntryId, passageIds } = await seedMaintenancePlan("work-m", ["One.", "Two."]);

    const response = await reviewWholeWork(planEntryId, "good", { status: "held" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as WholeWorkResponse).wholeWork.exists).toBe(true);

    // A clean whole-work run rates nothing, so the passages are still queued (no schedule, no reviews).
    for (const passageEntryId of passageIds) {
      const row = await passageRow(passageEntryId);
      expect(row.introducedAt).toBeNull();
      expect(row.dueAt).toBeNull();
    }
  });

  it("activates only the identified queued passage on a whole-work break", async () => {
    const { planEntryId, passageIds } = await seedMaintenancePlan("work-m", ["One.", "Two."]);

    const response = await reviewWholeWork(planEntryId, "good", {
      passageEntryId: passageIds[0]!,
      status: "broke"
    });
    expect(response.statusCode).toBe(200);

    // The broken passage is now an active, scheduled card that recorded its first review (the Again).
    // A fresh card taking Again enters learning without a lapse (a lapse needs a prior review card).
    const activated = await passageRow(passageIds[0]!);
    expect(activated.introducedAt).not.toBeNull();
    expect(activated.dueAt).not.toBeNull();
    expect(activated.reps).toBe(1);
    expect(activated.lapses).toBe(0);
    // Its sibling stays queued — a break never activates a passage the learner did not identify.
    const sibling = await passageRow(passageIds[1]!);
    expect(sibling.introducedAt).toBeNull();
    expect(sibling.dueAt).toBeNull();
  });

  it("surfaces whole-work upkeep on Today for a maintenance plan with only queued passages", async () => {
    const { planEntryId } = await seedMaintenancePlan("work-m", ["One.", "Two."]);

    // No passage is due (all queued) and no chain is active, so the maintenance plan's whole-work prompt
    // is what Today offers — proving the Today scan includes maintenance plans.
    const today = await getToday();
    expect(today.action).toBe("whole_work");
    expect(today.planEntryId).toBe(planEntryId);
  });
});

describe("GET /api/recitation/today", () => {
  it("selects a due passage first", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two."]);

    const today = await getToday();
    expect(today.action).toBe("due_passage");
    expect(today.planEntryId).toBe(planEntryId);
    expect(today.activeChain).toBeNull();
  });

  it("selects an active chain when nothing is due", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await ownPassage(passageIds[0]!);
    await ownPassage(passageIds[1]!);
    const started = await startChain(planEntryId, 1);
    const chainId = (started.json() as RecitationChainResponse).chain.chainId;

    const today = await getToday();
    expect(today.action).toBe("chain");
    expect(today.activeChain?.chainId).toBe(chainId);
    expect(today.planEntryId).toBe(planEntryId);
  });

  it("selects whole-work maintenance when nothing is due and no chain is active", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await ownPassage(passageIds[0]!);
    await ownPassage(passageIds[1]!);

    const today = await getToday();
    expect(today.action).toBe("whole_work");
    expect(today.planEntryId).toBe(planEntryId);
    expect(today.activeChain).toBeNull();
  });

  it("shows no action when the learner has no plans", async () => {
    const today = await getToday();
    expect(today).toEqual({
      action: "none",
      activeChain: null,
      planEntryId: null,
      workTitle: null
    });
  });
});
