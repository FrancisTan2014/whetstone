import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  RecitationPhaseDto,
  RecitationSessionDto,
  RecitationSessionResponse
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  personalEntries,
  readingUnits,
  recitationPlans,
  reviewCards,
  workMeta
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { RecitationChainingRouteDependencies } from "../recitationPassages/recitationChainingRoutes.js";
import type { RecitationPassageRouteDependencies } from "../recitationPassages/recitationPassageRoutes.js";
import type { RecitationRouteDependencies } from "./recitationRoutes.js";

const START = "2026-07-01T09:00:00.000Z";

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
  setNow: (iso: string) => void;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = new Date(START);
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
      currentUser: { getCurrentUserId: () => DEFAULT_USER_ID },
      logger: false,
      recitation,
      recitationChaining,
      recitationPassages
    }),
    setNow: (iso) => {
      now = new Date(iso);
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
): Promise<{ passageIds: string[]; planEntryId: string }> {
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

async function ownPassage(passageEntryId: string): Promise<void> {
  await reviewPassage(passageEntryId);
  await reviewPassage(passageEntryId);
}

async function startChain(planEntryId: string): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { endOrderIndex: 1 },
    url: `/api/recitation/plans/${planEntryId}/chain`
  });
  expect(response.statusCode).toBe(201);
}

async function reviewWholeWork(planEntryId: string): Promise<void> {
  const response = await context.server.inject({
    method: "POST",
    payload: { outcome: { status: "held" }, rating: "good" },
    url: `/api/recitation/plans/${planEntryId}/whole-work/review`
  });
  expect(response.statusCode).toBe(200);
}

async function setDueAt(targetEntryId: string, iso: string): Promise<void> {
  await context.db
    .update(reviewCards)
    .set({ dueAt: new Date(iso) })
    .where(eq(reviewCards.targetEntryId, targetEntryId));
}

async function firstWholeWorkTargetId(): Promise<string> {
  const [row] = await context.db
    .select({ entryId: entries.id })
    .from(entries)
    .where(eq(entries.type, "recitation_whole_work"))
    .limit(1);
  return row!.entryId;
}

async function getSession(pinned?: string): Promise<RecitationSessionDto> {
  const url =
    pinned === undefined
      ? "/api/recitation/session"
      : `/api/recitation/session?pinned=${encodeURIComponent(pinned)}`;
  const response = await context.server.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  return (response.json() as RecitationSessionResponse).session;
}

function activeSession(
  session: RecitationSessionDto
): Extract<RecitationSessionDto, { status: "active" }> {
  if (session.status !== "active") {
    throw new Error(`expected an active session, got ${session.status}`);
  }
  return session;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("GET /api/recitation/session", () => {
  it("returns no_plan when the learner has adopted nothing", async () => {
    expect(await getSession()).toEqual({ status: "no_plan" });
  });

  it("orders due passages before due whole-work before an active chain", async () => {
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    await startChain(planEntryId);
    await reviewWholeWork(planEntryId);
    await setDueAt(passageIds[0]!, "2026-07-01T08:00:00.000Z");
    await setDueAt(await firstWholeWorkTargetId(), "2026-07-01T08:00:00.000Z");

    let session = activeSession(await getSession());
    expect(session.step).toBe("due_passage");
    expect(session.hasDuePassage).toBe(true);
    expect(session.wholeWorkDue).toBe(true);
    expect(session.chainAvailable).toBe(true);

    await reviewPassage(passageIds[0]!);
    session = activeSession(await getSession());
    expect(session.step).toBe("whole_work");
    expect(session.hasDuePassage).toBe(false);
    expect(session.wholeWorkDue).toBe(true);
    expect(session.chainAvailable).toBe(true);
  });

  it("offers the chain step for an eligible owned prefix with no active chain, and starts it inline", async () => {
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    // Retire the whole-work prompt (own it) so it does not precede the chain step, leaving an eligible
    // owned prefix with no active chain — the projection must still surface the chain step.
    await reviewWholeWork(planEntryId);

    let session = activeSession(await getSession());
    expect(session.hasDuePassage).toBe(false);
    expect(session.wholeWorkDue).toBe(false);
    expect(session.chainAvailable).toBe(true);
    expect(session.step).toBe("chain");

    // The learner can start the chain inline; the projection then still holds the chain step (now active).
    await startChain(planEntryId);
    session = activeSession(await getSession());
    expect(session.chainAvailable).toBe(true);
    expect(session.step).toBe("chain");
  });

  it("recomputes to clear after the only due passage is rated", async () => {
    const { passageIds, planEntryId } = await seedPlan("work-1", ["Only."]);
    await introduceNext(planEntryId);

    expect(activeSession(await getSession()).step).toBe("due_passage");
    await reviewPassage(passageIds[0]!);

    const session = activeSession(await getSession());
    expect(session.step).toBe("clear");
    expect(session.due).toEqual({ dueCount: 0, nextDueAt: null, overdueCount: 0 });
  });

  it("works an older plan's due passage before a newer plan that only offers new material", async () => {
    const oldPlan = await seedPlan("work-1", ["Old."]);
    await introduceNext(oldPlan.planEntryId);

    context.setNow("2026-07-01T09:01:00.000Z");
    await seedPlan("work-2", ["New."]);

    // The aggregate routine works required obligations across every Work before any optional invitation,
    // so the newer plan's new-material invitation never hides the older plan's due passage (#633 AC1/AC5).
    const session = activeSession(await getSession());
    expect(session.planEntryId).toBe(oldPlan.planEntryId);
    expect(session.hasDuePassage).toBe(true);
    expect(session.step).toBe("due_passage");
    expect(session.newPassage.available).toBe(false);
  });

  it("aggregates due counts and the earliest instant across every active plan", async () => {
    const first = await seedPlan("work-1", ["One."]);
    await introduceNext(first.planEntryId);
    const second = await seedPlan("work-2", ["Two."]);
    await introduceNext(second.planEntryId);
    await setDueAt(first.passageIds[0]!, "2026-07-01T07:00:00.000Z");
    await setDueAt(second.passageIds[0]!, "2026-07-01T06:00:00.000Z");

    const session = activeSession(await getSession());
    expect(session.due.dueCount).toBe(2);
    expect(session.due.nextDueAt).toBe("2026-07-01T06:00:00.000Z");
    // With no pin the earliest-due Work leads.
    expect(session.planEntryId).toBe(second.planEntryId);
  });

  it("keeps the pinned Work selected while it holds required work, without changing the aggregate", async () => {
    const first = await seedPlan("work-1", ["One."]);
    await introduceNext(first.planEntryId);
    const second = await seedPlan("work-2", ["Two."]);
    await introduceNext(second.planEntryId);
    await setDueAt(first.passageIds[0]!, "2026-07-01T06:00:00.000Z");
    await setDueAt(second.passageIds[0]!, "2026-07-01T07:00:00.000Z");

    const session = activeSession(await getSession(second.planEntryId));
    // The pin holds the routine on the second Work even though the first is due earlier, so clearing the
    // second Work's items never context-switches mid-Work (#633 AC4)…
    expect(session.planEntryId).toBe(second.planEntryId);
    // …while the aggregate counts stay truthful across both Works regardless of which is selected.
    expect(session.due.dueCount).toBe(2);
    expect(session.due.nextDueAt).toBe("2026-07-01T06:00:00.000Z");
  });

  it("ignores a pin that no longer holds required work and advances to the next Work", async () => {
    const first = await seedPlan("work-1", ["One."]);
    await introduceNext(first.planEntryId);
    await setDueAt(first.passageIds[0]!, "2026-07-01T06:00:00.000Z");
    const second = await seedPlan("work-2", ["Two."]);
    // The second Work has only new material (nothing required), so pinning it falls through to the first.
    const session = activeSession(await getSession(second.planEntryId));
    expect(session.planEntryId).toBe(first.planEntryId);
    expect(session.step).toBe("due_passage");
  });

  it("excludes a paused plan yet still drives the routine from another active plan", async () => {
    const paused = await seedPlan("work-1", ["Paused."]);
    await introduceNext(paused.planEntryId);
    const active = await seedPlan("work-2", ["Active."]);
    await introduceNext(active.planEntryId);

    const pauseResponse = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${paused.planEntryId}/pause`
    });
    expect(pauseResponse.statusCode).toBe(200);

    const session = activeSession(await getSession());
    // Only the active Work's obligation counts; the paused Work contributes nothing to the aggregate.
    expect(session.planEntryId).toBe(active.planEntryId);
    expect(session.due.dueCount).toBe(1);
  });

  it("returns no_plan when every adopted plan is paused", async () => {
    const { planEntryId } = await seedPlan("work-1", ["One."]);
    await introduceNext(planEntryId);

    const response = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${planEntryId}/pause`
    });
    expect(response.statusCode).toBe(200);

    // The routine aggregates only unpaused plans, so a learner whose every plan is paused has no routine.
    expect(await getSession()).toEqual({ status: "no_plan" });
  });

  it("offers optional new material only when no Work holds required work", async () => {
    // A single fresh plan with seeded-but-unintroduced passages: nothing is required yet, so the routine
    // invites new material and points at that Work.
    const { planEntryId } = await seedPlan("work-1", ["One.", "Two."]);

    const idle = activeSession(await getSession());
    expect(idle.planEntryId).toBe(planEntryId);
    expect(idle.step).toBe("new_passage");
    expect(idle.newPassage.available).toBe(true);
  });

  it("suppresses the new-material invitation while the same Work still has a due passage", async () => {
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await setDueAt(passageIds[0]!, "2026-07-01T06:00:00.000Z");

    const session = activeSession(await getSession());
    // The Work still has capacity to introduce its second passage, but the due passage is required, so
    // the optional invitation is suppressed until the required work clears (#633 AC5).
    expect(session.step).toBe("due_passage");
    expect(session.newPassage.available).toBe(false);
  });

  it("treats an empty pinned query the same as no pin", async () => {
    const first = await seedPlan("work-1", ["One."]);
    await introduceNext(first.planEntryId);
    await setDueAt(first.passageIds[0]!, "2026-07-01T06:00:00.000Z");

    const session = activeSession(await getSession(""));
    expect(session.planEntryId).toBe(first.planEntryId);
  });

  it("excludes another user's plan from the learner's aggregate", async () => {
    await seedWorkWithBlocks("work-foreign", [{ id: "work-foreign-b0", text: "Foreign." }]);
    await context.db.transaction(async (tx) => {
      await tx.insert(entries).values({ id: "foreign-plan", type: "recitation_plan" });
      await tx.insert(personalEntries).values({
        createdAt: new Date(START),
        entryId: "foreign-plan",
        occurredAt: new Date(START),
        updatedAt: new Date(START),
        userId: "other-user"
      });
      await tx.insert(recitationPlans).values({
        entryId: "foreign-plan",
        phase: "learning",
        workEntryId: "work-foreign"
      });
    });

    // The current learner owns nothing; a plan owned by another user must never surface as their routine.
    expect(await getSession()).toEqual({ status: "no_plan" });
  });

  it("fails loud when any active plan cannot load, never reporting a false clear", async () => {
    const first = await seedPlan("work-1", ["One."]);
    await introduceNext(first.planEntryId);
    await seedPlan("work-2", ["Two."]);

    // Dropping a table every per-plan slice reads leaves plan listing intact but makes projecting any
    // plan throw, so the aggregate loader rejects rather than silently dropping a Work and under-reporting
    // the routine as clear (#633 AC2).
    await context.db.$client.query("DROP TABLE review_cards CASCADE");

    const response = await context.server.inject({
      method: "GET",
      url: "/api/recitation/session"
    });
    expect(response.statusCode).toBe(500);
  });

  it("summarizes the earliest due card as the due nextDueAt", async () => {
    const { passageIds, planEntryId } = await seedPlan("work-1", ["One.", "Two."]);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[0]!);
    await introduceNext(planEntryId);
    await ownPassage(passageIds[1]!);
    await setDueAt(passageIds[0]!, "2026-07-01T06:00:00.000Z");
    await setDueAt(passageIds[1]!, "2026-07-01T05:00:00.000Z");

    const session = activeSession(await getSession());
    expect(session.due.dueCount).toBe(2);
    expect(session.due.nextDueAt).toBe("2026-07-01T05:00:00.000Z");
  });
});
