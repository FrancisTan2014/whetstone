import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AuthoredWorkDto,
  RecitationPlanDto,
  RecitationPlanListDto,
  TimelineDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, entries, workMeta } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { AuthoredWorkRouteDependencies } from "../authoredWorks/authoredWorkRoutes.js";
import type { DiaryRouteDependencies } from "../diary/diaryRoutes.js";
import type { RecitationRouteDependencies } from "./recitationRoutes.js";

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
  const authoredWorks: AuthoredWorkRouteDependencies = {
    createEntryId: () => `id-${(sequence += 1)}`,
    db,
    now: () => now
  };
  const recitation: RecitationRouteDependencies = {
    createEntryId: () => `plan-${(sequence += 1)}`,
    db,
    now: () => now
  };
  // Mounted only so the shared Timeline endpoint exists for the "plan appears on the Timeline" test.
  const diary: DiaryRouteDependencies = {
    createId: () => `diary-${(sequence += 1)}`,
    db,
    now: () => now,
    saveAudio: () => Promise.resolve("voice-captures/test.audio")
  };

  return {
    db,
    server: createServer({
      authoredWorks,
      currentUser: { getCurrentUserId: () => userId },
      diary,
      logger: false,
      recitation
    }),
    setNow: (iso) => {
      now = new Date(iso);
    },
    setUser: (id) => {
      userId = id;
    }
  };
}

async function createAuthoredWork(title = "My essay"): Promise<AuthoredWorkDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: { language: "en", title, workType: "essay" },
    url: "/api/authored-works"
  });
  expect(response.statusCode).toBe(201);
  return response.json() as AuthoredWorkDto;
}

// An imported Work: only an `entries`/`work_meta` pair (no owning `personal_entries` facet), so adoption
// works for any Work in the Library, not just ones the current user authored.
async function seedImportedWork(entryId: string, title: string): Promise<string> {
  await context.db.transaction(async (tx) => {
    await tx.insert(authors).values({ id: `${entryId}-author`, name: "Aesop" });
    await tx.insert(entries).values({ id: entryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: `${entryId}-author`,
      entryId,
      language: "en",
      title,
      workType: "book"
    });
  });
  return entryId;
}

async function adopt(
  workEntryId: string,
  phase: RecitationPlanDto["phase"] = "familiarizing"
): Promise<RecitationPlanDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: { phase, workEntryId },
    url: "/api/recitation/plans"
  });
  expect(response.statusCode).toBe(201);
  return response.json() as RecitationPlanDto;
}

async function listPlans(): Promise<RecitationPlanListDto> {
  const response = await context.server.inject({ method: "GET", url: "/api/recitation/plans" });
  expect(response.statusCode).toBe(200);
  return response.json() as RecitationPlanListDto;
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

describe("POST /api/recitation/plans", () => {
  it("adopts an authored Work in the chosen phase", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const work = await createAuthoredWork("My essay");

    const plan = await adopt(work.entryId, "familiarizing");

    expect(plan).toMatchObject({
      createdAt: "2026-07-01T09:00:00.000Z",
      lastSessionAt: null,
      phase: "familiarizing",
      sessionCount: 0,
      updatedAt: "2026-07-01T09:00:00.000Z",
      workEntryId: work.entryId,
      workTitle: "My essay"
    });
  });

  it("adopts an imported Work at any starting phase", async () => {
    const workEntryId = await seedImportedWork("imported-1", "Aesop’s Fables");

    const plan = await adopt(workEntryId, "maintenance");

    expect(plan).toMatchObject({
      phase: "maintenance",
      workEntryId,
      workTitle: "Aesop’s Fables"
    });
  });

  it("rejects a malformed body at the boundary", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { phase: "not-a-phase", workEntryId: "x" },
      url: "/api/recitation/plans"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("returns 400 work_not_found for an unknown Work", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { phase: "familiarizing", workEntryId: "missing" },
      url: "/api/recitation/plans"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("returns 409 already_exists (with the existing plan) on a second adoption", async () => {
    const work = await createAuthoredWork();
    const first = await adopt(work.entryId);

    const response = await context.server.inject({
      method: "POST",
      payload: { phase: "learning", workEntryId: work.entryId },
      url: "/api/recitation/plans"
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "already_exists", plan: first });
  });
});

describe("GET /api/recitation/plans", () => {
  it("is empty before anything is adopted", async () => {
    expect(await listPlans()).toEqual({ plans: [] });
  });

  it("lists the user's plans, newest adopted first", async () => {
    const first = await createAuthoredWork("First");
    context.setNow("2026-07-01T09:00:00.000Z");
    await adopt(first.entryId);
    const second = await createAuthoredWork("Second");
    context.setNow("2026-07-02T09:00:00.000Z");
    await adopt(second.entryId);

    const { plans } = await listPlans();

    expect(plans.map((plan) => plan.workTitle)).toEqual(["Second", "First"]);
  });

  it("never leaks another user's plans", async () => {
    const work = await createAuthoredWork();
    await adopt(work.entryId);

    context.setUser(OTHER_USER_ID);

    expect(await listPlans()).toEqual({ plans: [] });
  });
});

describe("GET /api/recitation/continue", () => {
  async function loadContinue(): Promise<RecitationPlanDto | null> {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/recitation/continue"
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { plan: RecitationPlanDto | null }).plan;
  }

  it("is null when the user recites nothing", async () => {
    expect(await loadContinue()).toBeNull();
  });

  it("surfaces the most recently touched plan (a session outranks a later adoption)", async () => {
    const older = await createAuthoredWork("Older");
    context.setNow("2026-07-01T09:00:00.000Z");
    const olderPlan = await adopt(older.entryId);
    const newer = await createAuthoredWork("Newer");
    context.setNow("2026-07-02T09:00:00.000Z");
    await adopt(newer.entryId);

    // A newly adopted plan wins by recency…
    expect((await loadContinue())?.workTitle).toBe("Newer");

    // …until the older plan records a session, which lifts it back to the top.
    context.setNow("2026-07-03T09:00:00.000Z");
    await context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${olderPlan.entryId}/session`
    });

    expect((await loadContinue())?.workTitle).toBe("Older");
  });
});

describe("PUT /api/recitation/plans/:id/phase", () => {
  async function setPhase(id: string, phase: string) {
    return context.server.inject({
      method: "PUT",
      payload: { phase },
      url: `/api/recitation/plans/${id}/phase`
    });
  }

  it("transitions the phase and bumps updatedAt", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const work = await createAuthoredWork();
    const plan = await adopt(work.entryId, "familiarizing");

    context.setNow("2026-07-05T09:00:00.000Z");
    const response = await setPhase(plan.entryId, "learning");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entryId: plan.entryId,
      phase: "learning",
      updatedAt: "2026-07-05T09:00:00.000Z"
    });
  });

  it("rejects a malformed phase at the boundary", async () => {
    const work = await createAuthoredWork();
    const plan = await adopt(work.entryId);

    const response = await setPhase(plan.entryId, "nope");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("is 404 for a plan the user does not own", async () => {
    const work = await createAuthoredWork();
    const plan = await adopt(work.entryId);

    context.setUser(OTHER_USER_ID);
    const response = await setPhase(plan.entryId, "learning");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });
});

describe("POST /api/recitation/plans/:id/session", () => {
  async function recordSession(id: string) {
    return context.server.inject({
      method: "POST",
      url: `/api/recitation/plans/${id}/session`
    });
  }

  it("bumps the session count and stamps lastSessionAt without touching the phase", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const work = await createAuthoredWork();
    const plan = await adopt(work.entryId, "familiarizing");

    context.setNow("2026-07-04T09:00:00.000Z");
    const response = await recordSession(plan.entryId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      lastSessionAt: "2026-07-04T09:00:00.000Z",
      phase: "familiarizing",
      sessionCount: 1
    });
  });

  it("does not add a Timeline row (a reading session is not an Entry)", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const work = await createAuthoredWork("Recite me");
    const plan = await adopt(work.entryId);

    const before = await loadTimeline();
    const recitationBefore = before.days
      .flatMap((day) => day.entries)
      .filter((entry) => entry.kind === "recitation");
    expect(recitationBefore).toHaveLength(1);

    context.setNow("2026-07-02T09:00:00.000Z");
    await recordSession(plan.entryId);
    await recordSession(plan.entryId);

    const after = await loadTimeline();
    const recitationAfter = after.days
      .flatMap((day) => day.entries)
      .filter((entry) => entry.kind === "recitation");
    // Still exactly one recitation Timeline row — the sessions bumped routine state only.
    expect(recitationAfter).toHaveLength(1);
  });

  it("is 404 for a plan the user does not own", async () => {
    const work = await createAuthoredWork();
    const plan = await adopt(work.entryId);

    context.setUser(OTHER_USER_ID);
    const response = await recordSession(plan.entryId);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });
});

describe("Timeline inclusion", () => {
  it("shows an adopted plan as a recitation entry carrying the Work title and phase", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const work = await createAuthoredWork("腾王阁序");
    const plan = await adopt(work.entryId, "learning");

    const timeline = await loadTimeline();
    const recitation = timeline.days
      .flatMap((day) => day.entries)
      .find((entry) => entry.kind === "recitation");

    expect(recitation).toMatchObject({
      entryId: plan.entryId,
      kind: "recitation",
      phase: "learning",
      title: "腾王阁序",
      workEntryId: work.entryId
    });
  });
});
