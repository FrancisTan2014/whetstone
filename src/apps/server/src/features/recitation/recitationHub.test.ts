import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  RecitationHubDto,
  RecitationHubResponse,
  RecitationPhaseDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  readerPreferences,
  readingUnits,
  recitationPlans,
  reviewCards,
  workMeta
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { RecitationRouteDependencies } from "./recitationRoutes.js";
import type { RecitationChainingRouteDependencies } from "../recitationPassages/recitationChainingRoutes.js";
import type { RecitationPassageRouteDependencies } from "../recitationPassages/recitationPassageRoutes.js";

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
    createEntryId: () => `whole-work-${(sequence += 1)}`,
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

async function seedPlan(
  workEntryId: string,
  texts: readonly string[],
  phase: RecitationPhaseDto = "learning"
): Promise<{ planEntryId: string; passageIds: string[] }> {
  await seedWorkWithBlocks(
    workEntryId,
    texts.map((text, index) => ({ id: `${workEntryId}-b${index}`, text }))
  );
  const planEntryId = await adopt(workEntryId, phase);
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

async function reviewPassage(passageEntryId: string, rating = "good"): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { cueStrength: "opening", rating },
    url: `/api/recitation/passages/${passageEntryId}/review`
  });
  expect(response.statusCode).toBe(200);
}

async function ownPassage(passageEntryId: string, count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await reviewPassage(passageEntryId);
  }
}

async function startChain(planEntryId: string, endOrderIndex: number): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { endOrderIndex },
    url: `/api/recitation/plans/${planEntryId}/chain`
  });
  expect(response.statusCode).toBe(201);
}

async function getHub(): Promise<RecitationHubDto> {
  const response = await context.server.inject({ method: "GET", url: "/api/recitation/hub" });
  expect(response.statusCode).toBe(200);
  return (response.json() as RecitationHubResponse).hub;
}

function activeHub(hub: RecitationHubDto): Extract<RecitationHubDto, { status: "active" }> {
  if (hub.status !== "active") {
    throw new Error(`expected an active hub, got ${hub.status}`);
  }
  return hub;
}

async function reviewWholeWork(planEntryId: string, rating = "good"): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { outcome: { status: "held" }, rating },
    url: `/api/recitation/plans/${planEntryId}/whole-work/review`
  });
  expect(response.statusCode).toBe(200);
}

async function wholeWorkTargetId(): Promise<string> {
  const [row] = await context.db
    .select({ entryId: entries.id })
    .from(entries)
    .where(eq(entries.type, "recitation_whole_work"));
  return row!.entryId;
}

async function setDueAt(targetEntryId: string, iso: string): Promise<void> {
  await context.db
    .update(reviewCards)
    .set({ dueAt: new Date(iso) })
    .where(eq(reviewCards.targetEntryId, targetEntryId));
}

async function setTimeZone(userId: string, timeZone: string): Promise<void> {
  await context.db
    .insert(readerPreferences)
    .values({ readingSize: "medium", theme: "day", timezone: timeZone, userId });
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("GET /api/recitation/hub — projection", () => {
  it("returns no_plan when the learner has adopted nothing", async () => {
    expect(await getHub()).toEqual({ status: "no_plan" });
  });

  it("projects a familiarizing plan at the familiarize stage with no due work", async () => {
    await seedWorkWithBlocks("work-1", [{ id: "work-1-b0", text: "Line." }]);
    await adopt("work-1", "familiarizing");

    const hub = activeHub(await getHub());
    expect(hub.workTitle).toBe("Work work-1");
    expect(hub.phase).toBe("familiarizing");
    expect(hub.paused).toBe(false);
    expect(hub.stage).toBe("familiarize");
    expect(hub.passages).toEqual({ introducedCount: 0, totalCount: 0 });
    expect(hub.due).toEqual({ dueCount: 0, overdueCount: 0 });
    expect(hub.primaryAction).toBe("none");
  });

  it("projects a learning plan with one introduced due passage at learn_passage with a due_passage action", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two.", "Three."]);
    await introduceNext(planEntryId);

    const hub = activeHub(await getHub());
    expect(hub.phase).toBe("learning");
    expect(hub.stage).toBe("learn_passage");
    expect(hub.passages).toEqual({ introducedCount: 1, totalCount: 3 });
    expect(hub.due.dueCount).toBe(1);
    expect(hub.primaryAction).toBe("due_passage");
    // The paced-introduction status is embedded straight from the canonical evaluator (#607).
    expect(hub.introduction.dailyCap).toBe(3);
    expect(hub.introduction.planEntryId).toBe(planEntryId);
  });

  it("moves to the chain stage once the owned prefix makes chaining eligible", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two.", "Three."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);

    const hub = activeHub(await getHub());
    // Two adjacent owned passages make a chain eligible even before one is started.
    expect(hub.stage).toBe("chain");
  });

  it("surfaces a chain action when a chain is active and no passage is due", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    await startChain(planEntryId, 1);

    const hub = activeHub(await getHub());
    expect(hub.stage).toBe("chain");
    // Owned passages were rescheduled into the future, so nothing is due; the active chain wins.
    expect(hub.due.dueCount).toBe(0);
    expect(hub.primaryAction).toBe("chain");
  });

  it("projects a maintenance plan at whole_work_maintenance with a whole_work action before any card exists", async () => {
    await seedPlan("work-1", ["One.", "Two."], "maintenance");

    const hub = activeHub(await getHub());
    expect(hub.phase).toBe("maintenance");
    expect(hub.stage).toBe("whole_work_maintenance");
    // An unstarted whole-Work prompt has no card yet, so nothing counts as due, but it is the action.
    expect(hub.due).toEqual({ dueCount: 0, overdueCount: 0 });
    expect(hub.primaryAction).toBe("whole_work");
  });

  it("counts overdue by the learner's local-day boundary, not UTC", async () => {
    await setTimeZone(DEFAULT_USER_ID, "Asia/Shanghai");
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);

    // Local noon on 2026-07-01 in UTC+8 → the local day starts at 2026-06-30T16:00:00Z.
    context.setNow("2026-07-01T04:00:00.000Z");
    // Before the local-day start → carried over → overdue.
    await setDueAt(passageIds[0]!, "2026-06-30T12:00:00.000Z");
    // After the local-day start but at/-before now → due today, NOT overdue (would be overdue under UTC).
    await setDueAt(passageIds[1]!, "2026-06-30T20:00:00.000Z");

    const hub = activeHub(await getHub());
    expect(hub.due).toEqual({ dueCount: 2, overdueCount: 1 });
  });

  it("counts the whole-Work card and offers a whole_work action once its aggregate card is due", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two."], "maintenance");
    // Start the aggregate card with a held review — it exists but is scheduled into the future.
    await reviewWholeWork(planEntryId);

    let hub = activeHub(await getHub());
    expect(hub.due).toEqual({ dueCount: 0, overdueCount: 0 });
    expect(hub.primaryAction).toBe("none");

    // Pull the aggregate card's due date into the past; the hub now counts it and offers whole-Work.
    await setDueAt(await wholeWorkTargetId(), "2026-07-01T08:00:00.000Z");
    hub = activeHub(await getHub());
    expect(hub.due.dueCount).toBe(1);
    expect(hub.primaryAction).toBe("whole_work");
  });

  it("derives due purely from the canonical card — no persisted hub status", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    expect(activeHub(await getHub()).due.dueCount).toBe(1);

    // Push the card far into the future directly; the hub reflects it with no hub-side write.
    await setDueAt(passageIds[0]!, "2027-01-01T00:00:00.000Z");
    const hub = activeHub(await getHub());
    expect(hub.due.dueCount).toBe(0);
    expect(hub.primaryAction).toBe("none");
  });
});

describe("pause / resume", () => {
  it("removes a paused plan's due work and action from the hub, then restores it on resume", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    const before = activeHub(await getHub());
    expect(before.primaryAction).toBe("due_passage");
    expect(before.due.dueCount).toBe(1);

    const [cardBefore] = await context.db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, passageIds[0]!));

    const paused = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/pause`
    });
    expect(paused.statusCode).toBe(200);
    const pausedHub = activeHub((paused.json() as RecitationHubResponse).hub);
    expect(pausedHub.paused).toBe(true);
    expect(pausedHub.due).toEqual({ dueCount: 0, overdueCount: 0 });
    expect(pausedHub.primaryAction).toBe("none");

    // A paused plan is also excluded from cross-plan Today selection and the due-passage scan.
    const today = await context.server.inject({ method: "GET", url: "/api/recitation/today" });
    expect((today.json() as { today: { action: string } }).today.action).toBe("none");
    const due = await context.server.inject({
      method: "GET",
      url: "/api/recitation/passages/due"
    });
    expect((due.json() as { passage: unknown }).passage).toBeNull();

    const resumed = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/resume`
    });
    expect(resumed.statusCode).toBe(200);
    const resumedHub = activeHub((resumed.json() as RecitationHubResponse).hub);
    expect(resumedHub.paused).toBe(false);
    expect(resumedHub.due.dueCount).toBe(1);
    expect(resumedHub.primaryAction).toBe("due_passage");

    // The schedule was preserved untouched across pause/resume — no reset.
    const [cardAfter] = await context.db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, passageIds[0]!));
    expect(cardAfter!.dueAt.toISOString()).toBe(cardBefore!.dueAt.toISOString());
  });

  it("keeps the routine stage and an active chain across pause/resume", async () => {
    const { planEntryId, passageIds } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    await startChain(planEntryId, 1);

    await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/pause`
    });
    const pausedHub = activeHub(await getHub());
    // Where the learner is in the Work is preserved; only the action is withheld while paused.
    expect(pausedHub.stage).toBe("chain");
    expect(pausedHub.primaryAction).toBe("none");

    await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/resume`
    });
    const resumedHub = activeHub(await getHub());
    expect(resumedHub.stage).toBe("chain");
    expect(resumedHub.primaryAction).toBe("chain");
  });

  it("is idempotent when pausing twice and resuming an active plan", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two."]);

    for (let i = 0; i < 2; i += 1) {
      const paused = await context.server.inject({
        method: "POST",
        url: `/api/recitation/plans/${planEntryId}/pause`
      });
      expect(paused.statusCode).toBe(200);
      expect(activeHub((paused.json() as RecitationHubResponse).hub).paused).toBe(true);
    }
    const [row] = await context.db
      .select({ pausedAt: recitationPlans.pausedAt })
      .from(recitationPlans)
      .where(eq(recitationPlans.entryId, planEntryId));
    expect(row!.pausedAt).not.toBeNull();

    const resumed = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/resume`
    });
    expect(resumed.statusCode).toBe(200);
    expect(activeHub((resumed.json() as RecitationHubResponse).hub).paused).toBe(false);
    const [cleared] = await context.db
      .select({ pausedAt: recitationPlans.pausedAt })
      .from(recitationPlans)
      .where(eq(recitationPlans.entryId, planEntryId));
    expect(cleared!.pausedAt).toBeNull();
  });

  it("404s pause and resume for a plan the learner does not own", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One."]);
    context.setUser(OTHER_USER_ID);

    const paused = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/pause`
    });
    expect(paused.statusCode).toBe(404);
    const resumed = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/resume`
    });
    expect(resumed.statusCode).toBe(404);
  });

  it("404s pause for a plan that does not exist", async () => {
    const missing = await context.server.inject({
      method: "POST",
      url: "/api/recitation/plans/nope/pause"
    });
    expect(missing.statusCode).toBe(404);
  });
});
