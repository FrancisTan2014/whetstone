import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecitationPlanDto, RecitationReviewDto, TimelineDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  blocks,
  entries,
  entryLinks,
  personalEntries,
  recitationPlans,
  recitationWholeWork,
  reviewCards,
  reviewEvents,
  workMeta
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { DiaryRouteDependencies } from "../diary/diaryRoutes.js";
import {
  enrollRecitation,
  pauseRecitation,
  recordRecitationReview,
  removeRecitation,
  resumeRecitation,
  type RecitationDependencies
} from "./recitationCommands.js";
import {
  loadRecitationReview,
  loadRecitationRoutineSummary,
  loadWholeWorkTarget,
  loadWorkSourceText
} from "./recitationReviewQueries.js";
import { deleteRecitationReviewData } from "./recitationTeardown.js";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";

type TestContext = Readonly<{
  db: DbClient;
  deps: RecitationDependencies;
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
  let entrySequence = 0;
  let eventSequence = 0;
  const deps: RecitationDependencies = {
    createEntryId: () => `e-${(entrySequence += 1)}`,
    createId: () => `ev-${(eventSequence += 1)}`,
    db,
    now: () => now
  };
  const diary: DiaryRouteDependencies = {
    createId: () => `diary-${(entrySequence += 1)}`,
    db,
    now: () => now,
    saveAudio: () => Promise.resolve("voice-captures/test.audio")
  };

  return {
    db,
    deps,
    server: createServer({
      currentUser: { getCurrentUserId: () => userId },
      diary,
      logger: false,
      recitation: deps,
      today: { db, now: () => now }
    }),
    setNow: (iso) => {
      now = new Date(iso);
    },
    setUser: (id) => {
      userId = id;
    }
  };
}

// An imported Work with block content: `entries`/`work_meta` plus ordered `blocks`, so the review can
// reveal the canonical source live and enrollment works for any Library Work, not just authored ones.
async function seedWork(
  workEntryId: string,
  title: string,
  lines: ReadonlyArray<string> = ["Line one.", "Line two."]
): Promise<string> {
  await context.db.transaction(async (tx) => {
    await tx.insert(authors).values({ id: `${workEntryId}-author`, name: "Aesop" });
    await tx.insert(entries).values({ id: workEntryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: `${workEntryId}-author`,
      entryId: workEntryId,
      language: "en",
      title,
      workType: "book"
    });
    for (const [index, plaintext] of lines.entries()) {
      const blockEntryId = `${workEntryId}-b${index}`;
      await tx.insert(entries).values({ id: blockEntryId, type: "block" });
      await tx.insert(blocks).values({
        blockType: "paragraph",
        entryId: blockEntryId,
        mdastJson: { type: "root" },
        orderIndex: index,
        plaintext,
        workEntryId
      });
    }
  });
  return workEntryId;
}

async function enroll(workEntryId: string): Promise<RecitationPlanDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: { workEntryId },
    url: "/api/recitation/enroll"
  });
  expect(response.statusCode).toBe(200);
  return response.json() as RecitationPlanDto;
}

async function fetchReview(workEntryId?: string): Promise<RecitationReviewDto | null> {
  const url =
    workEntryId === undefined
      ? "/api/recitation/review"
      : `/api/recitation/review?work=${encodeURIComponent(workEntryId)}`;
  const response = await context.server.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  return (response.json() as { review: RecitationReviewDto | null }).review;
}

async function countRows(table: typeof reviewCards | typeof reviewEvents): Promise<number> {
  return (await context.db.select().from(table)).length;
}

async function loadTimeline(): Promise<TimelineDto> {
  const response = await context.server.inject({ method: "GET", url: "/api/diary/timeline" });
  expect(response.statusCode).toBe(200);
  return response.json() as TimelineDto;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("POST /api/recitation/enroll", () => {
  it("enrolls a known Work into maintenance with one target and one due-now card", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const workEntryId = await seedWork("work-1", "Fables");

    const plan = await enroll(workEntryId);

    expect(plan).toMatchObject({
      createdAt: "2026-07-01T09:00:00.000Z",
      phase: "maintenance",
      sessionCount: 0,
      workEntryId,
      workTitle: "Fables"
    });

    const targets = await context.db
      .select()
      .from(recitationWholeWork)
      .where(eq(recitationWholeWork.planEntryId, plan.entryId));
    expect(targets).toHaveLength(1);

    const links = await context.db
      .select()
      .from(entryLinks)
      .where(and(eq(entryLinks.fromEntryId, plan.entryId), eq(entryLinks.type, "contains")));
    expect(links).toHaveLength(1);
    expect(links[0]!.toEntryId).toBe(targets[0]!.entryId);

    const cards = await context.db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, targets[0]!.entryId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("active");
    expect(cards[0]!.requestedRetention).toBe(0.95);
    expect(cards[0]!.dueAt.getTime()).toBeLessThanOrEqual(
      new Date("2026-07-01T09:00:00.000Z").getTime()
    );
  });

  it("rejects an unknown Work with work_not_found", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { workEntryId: "missing" },
      url: "/api/recitation/enroll"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("rejects a malformed enrollment body", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { workEntryId: "   " },
      url: "/api/recitation/enroll"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("is idempotent: repeating enrollment never duplicates the plan, target, card, or history", async () => {
    const workEntryId = await seedWork("work-1", "Fables");

    const first = await enroll(workEntryId);
    const second = await enroll(workEntryId);

    expect(second.entryId).toBe(first.entryId);
    expect(await context.db.select().from(recitationPlans)).toHaveLength(1);
    expect(await context.db.select().from(recitationWholeWork)).toHaveLength(1);
    expect(await countRows(reviewCards)).toBe(1);
    expect(await countRows(reviewEvents)).toBe(0);
  });

  it("persists before any review and appends no event when the learner leaves before rating", async () => {
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);

    // Leaving before rating: the plan and its due card persist, but no review event was written.
    expect(await countRows(reviewEvents)).toBe(0);
    const target = await loadWholeWorkTarget(context.db, plan.entryId, DEFAULT_USER_ID);
    expect(target!.card.status).toBe("active");
    expect(target!.card.dueAt.getTime()).toBeLessThanOrEqual(context.deps.now().getTime());
  });

  it("places the plan on the learner's Timeline as a durable owned Entry", async () => {
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);

    const timeline = await loadTimeline();
    const entries = timeline.days.flatMap((day) => day.entries);
    expect(
      entries.some((entry) => entry.kind === "recitation" && entry.entryId === plan.entryId)
    ).toBe(true);
  });
});

describe("GET /api/recitation/review", () => {
  it("opens the exact Work's review revealing the canonical source", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const workEntryId = await seedWork("work-1", "Fables", ["First line.", "Second line."]);
    const plan = await enroll(workEntryId);

    const review = await fetchReview(workEntryId);

    expect(review).toMatchObject({
      planEntryId: plan.entryId,
      sourceText: "First line.\nSecond line.",
      state: "new",
      workEntryId,
      workTitle: "Fables"
    });
  });

  it("returns null for a Work the learner does not recite", async () => {
    await seedWork("work-1", "Fables");
    expect(await fetchReview("work-1")).toBeNull();
  });

  it("returns null for a Work whose maintenance was removed", async () => {
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);
    await removeRecitation(context.deps, toEntryId(plan.entryId), DEFAULT_USER_ID);

    expect(await fetchReview(workEntryId)).toBeNull();
  });

  it("returns null for a paused Work", async () => {
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);
    await pauseRecitation(context.deps, toEntryId(plan.entryId), DEFAULT_USER_ID);

    expect(await fetchReview(workEntryId)).toBeNull();
  });

  it("with no Work chosen, picks the earliest-due enrolled Work", async () => {
    const first = await enroll(await seedWork("work-1", "One"));
    await enroll(await seedWork("work-2", "Two"));

    const review = await fetchReview();
    expect(review!.planEntryId).toBe(first.entryId);
  });

  it("with no Work chosen and nothing due, returns null", async () => {
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);
    // Rate it well so its card reschedules into the future and nothing is due now.
    await recordRecitationReview(context.deps, toEntryId(plan.entryId), "easy", DEFAULT_USER_ID);

    expect(await fetchReview()).toBeNull();
  });
});

describe("POST /api/recitation/plans/:id/review", () => {
  it("appends one event and reschedules only the Work-level card", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);

    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: `/api/recitation/plans/${plan.entryId}/review`
    });
    expect(response.statusCode).toBe(200);
    const { review } = response.json() as { review: RecitationReviewDto };
    expect(review.workEntryId).toBe(workEntryId);
    expect(new Date(review.dueAt).getTime()).toBeGreaterThan(context.deps.now().getTime());

    const events = await context.db.select().from(reviewEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!).toMatchObject({ rating: "good", type: "rating" });
  });

  it("rejects a malformed rating at the boundary", async () => {
    const plan = await enroll(await seedWork("work-1", "Fables"));
    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "perfect" },
      url: `/api/recitation/plans/${plan.entryId}/review`
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("is 404 for a forged or cross-user plan id", async () => {
    const plan = await enroll(await seedWork("work-1", "Fables"));

    const forged = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: "/api/recitation/plans/nope/review"
    });
    expect(forged.statusCode).toBe(404);

    context.setUser(OTHER_USER_ID);
    const crossUser = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: `/api/recitation/plans/${plan.entryId}/review`
    });
    expect(crossUser.statusCode).toBe(404);
  });

  it("is not_found when the plan has no Work-level card", async () => {
    // A legacy plan with no whole-work target: rating it finds no card to reschedule.
    await context.db.insert(entries).values({ id: "legacy-plan", type: "recitation_plan" });
    await context.db.insert(personalEntries).values({
      createdAt: context.deps.now(),
      entryId: "legacy-plan",
      occurredAt: context.deps.now(),
      updatedAt: context.deps.now(),
      userId: DEFAULT_USER_ID
    });
    const workEntryId = await seedWork("work-1", "Fables");
    await context.db
      .insert(recitationPlans)
      .values({ entryId: "legacy-plan", phase: "maintenance", workEntryId });

    const result = await recordRecitationReview(
      context.deps,
      toEntryId("legacy-plan"),
      "good",
      DEFAULT_USER_ID
    );
    expect(result).toEqual({ status: "not_found" });
  });
});

describe("scheduled resurfacing on Today", () => {
  it("excludes a freshly-rated Work but resurfaces it once its next due date arrives", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);

    await recordRecitationReview(context.deps, toEntryId(plan.entryId), "good", DEFAULT_USER_ID);

    const afterRating = await loadRecitationReview(
      { db: context.db },
      DEFAULT_USER_ID,
      context.deps.now()
    );
    expect(afterRating).toBeNull();

    // Advance well past the next scheduled due instant: the card contributes to due work again.
    context.setNow("2027-07-01T09:00:00.000Z");
    const resurfaced = await loadRecitationReview(
      { db: context.db },
      DEFAULT_USER_ID,
      context.deps.now()
    );
    expect(resurfaced!.planEntryId).toBe(plan.entryId);

    const summary = await loadRecitationRoutineSummary(
      { db: context.db },
      DEFAULT_USER_ID,
      context.deps.now(),
      "UTC"
    );
    expect(summary.dueCount).toBe(1);
    expect(summary.overdueCount).toBe(1);
    expect(summary.nextDueAt).not.toBeNull();
  });

  it("reports a clear Recitation routine when no Work-level card is due", async () => {
    const plan = await enroll(await seedWork("work-1", "Fables"));
    await recordRecitationReview(context.deps, toEntryId(plan.entryId), "easy", DEFAULT_USER_ID);

    const summary = await loadRecitationRoutineSummary(
      { db: context.db },
      DEFAULT_USER_ID,
      context.deps.now(),
      "UTC"
    );
    expect(summary).toEqual({ dueCount: 0, nextDueAt: null, overdueCount: 0 });
  });
});

describe("deleteRecitationReviewData (Work-deletion cascade)", () => {
  it("tears down a target's card even when it has no review events", async () => {
    // A learner enrolled a Work but never rated it: the Work-level target has a card and zero events.
    // Deleting the Work must still remove the card, exercising the no-events branch of the teardown.
    const plan = await enroll(await seedWork("work-1", "Fables"));
    const target = await loadWholeWorkTarget(context.db, plan.entryId, DEFAULT_USER_ID);
    expect(await countRows(reviewEvents)).toBe(0);

    await context.db.transaction((tx) => deleteRecitationReviewData(tx, [target!.targetEntryId]));

    expect(await countRows(reviewCards)).toBe(0);
  });
});

describe("GET /api/today", () => {
  it("surfaces a due Recitation row and clears once the Work is rated", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const plan = await enroll(await seedWork("work-1", "Fables"));

    const dueBoard = (
      (await context.server.inject({ method: "GET", url: "/api/today" })).json() as {
        board: { clear: boolean; dueNow: ReadonlyArray<{ kind: string }> };
      }
    ).board;
    expect(dueBoard.dueNow.some((row) => row.kind === "recitation")).toBe(true);

    await recordRecitationReview(context.deps, toEntryId(plan.entryId), "easy", DEFAULT_USER_ID);

    const clearBoard = (
      (await context.server.inject({ method: "GET", url: "/api/today" })).json() as {
        board: { clear: boolean; dueNow: ReadonlyArray<{ kind: string }> };
      }
    ).board;
    expect(clearBoard.dueNow.some((row) => row.kind === "recitation")).toBe(false);
  });
});

describe("pause, resume, and remove maintenance", () => {
  it("pausing withholds the card and preserves the Work and source content; resume restores it", async () => {
    const workEntryId = await seedWork("work-1", "Fables", ["Kept one.", "Kept two."]);
    const plan = await enroll(workEntryId);

    const pauseResponse = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${plan.entryId}/pause`
    });
    expect(pauseResponse.statusCode).toBe(200);

    const pausedPlan = await context.db
      .select()
      .from(recitationPlans)
      .where(eq(recitationPlans.entryId, plan.entryId));
    expect(pausedPlan[0]!.pausedAt).not.toBeNull();
    const target = await loadWholeWorkTarget(context.db, plan.entryId, DEFAULT_USER_ID);
    expect(target!.card.status).toBe("paused");
    // The Work and its blocks are untouched.
    expect(await loadWorkSourceText(context.db, workEntryId)).toBe("Kept one.\nKept two.");

    const resumeResponse = await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${plan.entryId}/resume`
    });
    expect(resumeResponse.statusCode).toBe(200);
    const resumed = await loadWholeWorkTarget(context.db, plan.entryId, DEFAULT_USER_ID);
    expect(resumed!.card.status).toBe("active");
  });

  it("removing drops the card but preserves the Work, its content, and re-enrolls fresh", async () => {
    const workEntryId = await seedWork("work-1", "Fables", ["Kept one."]);
    const plan = await enroll(workEntryId);

    const removeResponse = await context.server.inject({
      method: "DELETE",
      url: `/api/recitation/plans/${plan.entryId}`
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(removeResponse.json()).toEqual({ removed: true });
    expect(await countRows(reviewCards)).toBe(0);
    // The Work and its blocks survive.
    expect(await loadWorkSourceText(context.db, workEntryId)).toBe("Kept one.");

    // Re-enrolling the same Work converts the existing plan in place and seeds a fresh card.
    const reEnrolled = await enroll(workEntryId);
    expect(reEnrolled.entryId).toBe(plan.entryId);
    expect(await countRows(reviewCards)).toBe(1);
  });

  it("re-enrolling a paused plan resumes its card in place without a duplicate", async () => {
    const workEntryId = await seedWork("work-1", "Fables");
    const plan = await enroll(workEntryId);
    await pauseRecitation(context.deps, toEntryId(plan.entryId), DEFAULT_USER_ID);

    const reEnrolled = await enroll(workEntryId);
    expect(reEnrolled.entryId).toBe(plan.entryId);
    const target = await loadWholeWorkTarget(context.db, plan.entryId, DEFAULT_USER_ID);
    expect(target!.card.status).toBe("active");
    expect(await countRows(reviewCards)).toBe(1);
    const paused = await context.db
      .select()
      .from(recitationPlans)
      .where(eq(recitationPlans.entryId, plan.entryId));
    expect(paused[0]!.pausedAt).toBeNull();
  });

  it("is 404 to pause, resume, or remove a plan the learner does not own", async () => {
    const plan = await enroll(await seedWork("work-1", "Fables"));
    context.setUser(OTHER_USER_ID);

    for (const request of [
      { method: "POST" as const, url: `/api/recitation/plans/${plan.entryId}/pause` },
      { method: "POST" as const, url: `/api/recitation/plans/${plan.entryId}/resume` },
      { method: "DELETE" as const, url: `/api/recitation/plans/${plan.entryId}` }
    ]) {
      const response = await context.server.inject(request);
      expect(response.statusCode).toBe(404);
    }
  });

  it("pausing and removing a plan with no Work-level target are safe no-ops", async () => {
    // A legacy plan with no whole-work target exercises the "no card to touch" branches.
    await context.db.insert(entries).values({ id: "legacy-plan", type: "recitation_plan" });
    await context.db.insert(personalEntries).values({
      createdAt: context.deps.now(),
      entryId: "legacy-plan",
      occurredAt: context.deps.now(),
      updatedAt: context.deps.now(),
      userId: DEFAULT_USER_ID
    });
    const workEntryId = await seedWork("work-1", "Fables");
    await context.db
      .insert(recitationPlans)
      .values({ entryId: "legacy-plan", phase: "maintenance", workEntryId });

    expect(await pauseRecitation(context.deps, toEntryId("legacy-plan"), DEFAULT_USER_ID)).toBe(
      "updated"
    );
    expect(await resumeRecitation(context.deps, toEntryId("legacy-plan"), DEFAULT_USER_ID)).toBe(
      "updated"
    );
    expect(await removeRecitation(context.deps, toEntryId("legacy-plan"), DEFAULT_USER_ID)).toBe(
      "updated"
    );
  });
});

describe("explicit zero-target conversion", () => {
  it("converts an existing plan with no active target to maintenance without replacing identity", async () => {
    // A legacy familiarizing plan with no whole-work target and no card.
    await context.db.insert(entries).values({ id: "legacy-plan", type: "recitation_plan" });
    await context.db.insert(personalEntries).values({
      createdAt: context.deps.now(),
      entryId: "legacy-plan",
      occurredAt: context.deps.now(),
      updatedAt: context.deps.now(),
      userId: DEFAULT_USER_ID
    });
    const workEntryId = await seedWork("work-1", "Fables");
    await context.db
      .insert(recitationPlans)
      .values({ entryId: "legacy-plan", phase: "familiarizing", workEntryId });

    const result = await enrollRecitation(context.deps, workEntryId, DEFAULT_USER_ID);
    expect(result.status).toBe("enrolled");
    expect(result.status === "enrolled" && result.plan.entryId).toBe("legacy-plan");
    expect(result.status === "enrolled" && result.plan.phase).toBe("maintenance");

    // Durable identity preserved: still exactly one plan, keyed by the same id, now with a live card.
    expect(await context.db.select().from(recitationPlans)).toHaveLength(1);
    const target = await loadWholeWorkTarget(context.db, "legacy-plan", DEFAULT_USER_ID);
    expect(target!.card.status).toBe("active");
  });
});

describe("GET /api/recitation/plans", () => {
  it("lists the learner's plans newest-first so the Library can mark enrolled Works", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const first = await enroll(await seedWork("work-1", "One"));
    context.setNow("2026-07-02T09:00:00.000Z");
    const second = await enroll(await seedWork("work-2", "Two"));

    const response = await context.server.inject({ method: "GET", url: "/api/recitation/plans" });
    expect(response.statusCode).toBe(200);
    const { plans } = response.json() as { plans: ReadonlyArray<RecitationPlanDto> };
    expect(plans.map((plan) => plan.entryId)).toEqual([second.entryId, first.entryId]);
    expect(plans.every((plan) => plan.phase === "maintenance")).toBe(true);
  });

  it("surfaces a legacy plan's last-session timestamp when present", async () => {
    const plan = await enroll(await seedWork("work-1", "One"));
    await context.db
      .update(recitationPlans)
      .set({ lastSessionAt: new Date("2026-06-15T08:00:00.000Z") })
      .where(eq(recitationPlans.entryId, plan.entryId));

    const response = await context.server.inject({ method: "GET", url: "/api/recitation/plans" });
    const { plans } = response.json() as { plans: ReadonlyArray<RecitationPlanDto> };
    expect(plans[0]!.lastSessionAt).toBe("2026-06-15T08:00:00.000Z");
  });

  it("excludes another learner's plans", async () => {
    await enroll(await seedWork("work-1", "One"));
    context.setUser(OTHER_USER_ID);

    const response = await context.server.inject({ method: "GET", url: "/api/recitation/plans" });
    expect((response.json() as { plans: ReadonlyArray<unknown> }).plans).toEqual([]);
  });
});

describe("a removed plan never contributes due work", () => {
  it("drops from the no-Work review selection and the routine summary though its plan stays active", async () => {
    // Removal deletes the Work-level card but leaves the plan unpaused (its durable identity persists). The
    // aggregate must treat that active-but-cardless plan as a zero obligation, never a false due row.
    const plan = await enroll(await seedWork("work-1", "Fables"));
    await removeRecitation(context.deps, toEntryId(plan.entryId), DEFAULT_USER_ID);

    expect(await fetchReview()).toBeNull();
    const summary = await loadRecitationRoutineSummary(
      { db: context.db },
      DEFAULT_USER_ID,
      context.deps.now(),
      "UTC"
    );
    expect(summary).toEqual({ dueCount: 0, nextDueAt: null, overdueCount: 0 });
  });

  it("withholds a card that is paused out of lockstep with an active plan row", async () => {
    // Defensive invariant: even if a Work-level card is paused while its plan row still reads active, the
    // due scan must exclude it — a withheld card never contributes to due work or the no-Work selection.
    const plan = await enroll(await seedWork("work-1", "Fables"));
    const target = await loadWholeWorkTarget(context.db, plan.entryId, DEFAULT_USER_ID);
    await context.db
      .update(reviewCards)
      .set({ status: "paused" })
      .where(eq(reviewCards.targetEntryId, target!.targetEntryId));

    expect(await fetchReview()).toBeNull();
    const summary = await loadRecitationRoutineSummary(
      { db: context.db },
      DEFAULT_USER_ID,
      context.deps.now(),
      "UTC"
    );
    expect(summary).toEqual({ dueCount: 0, nextDueAt: null, overdueCount: 0 });
  });
});
