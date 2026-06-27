import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeCoach } from "../../coach/fakeCoach.js";
import { createLoggerOptions } from "../../config/serverConfig.js";
import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { cases, domains } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { authorCase } from "../authoring/authoringCommands.js";
import { seedCaseCorpus } from "../cases/caseSeed.js";
import { depositTurnOutcome } from "../learner/learnerCommands.js";
import { enrollRecallItem, recordRecallReview } from "../recall/recallCommands.js";
import { compileProgressMap } from "./mapQueries.js";

const userA = "user-a";
const t0 = new Date("2026-01-01T00:00:00.000Z");

let db: DbClient;
let sequence = 0;
const createId = (): string => `id-${(sequence += 1)}`;

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const client = createDbClient(pglite);
  await seedCaseCorpus(client);
  return client;
}

async function enroll(chunkId: string, reviews: number): Promise<void> {
  const item = await enrollRecallItem(
    { createId, db },
    { chunkId, kind: "chunk", text: chunkId },
    userA,
    t0
  );
  for (let i = 0; i < reviews; i += 1) {
    await recordRecallReview({ createId, db }, item.id, 4, userA, t0);
  }
}

beforeEach(async () => {
  sequence = 0;
  db = await buildDb();
});

afterEach(async () => {
  await db.$client.close();
});

describe("compileProgressMap", () => {
  it("renders every active case dark for a fresh learner and recommends the highest-value region", async () => {
    const map = await compileProgressMap(db, userA, t0);

    const allCases = map.domains.flatMap((domain) => domain.cases);
    expect(allCases.length).toBeGreaterThan(0);
    expect(allCases.every((mapCase) => mapCase.light === "dark")).toBe(true);
    expect(map.signals.ownedChunks).toBe(0);
    expect(map.signals.weakChunks).toBe(0);
    expect(map.signals.totalChunks).toBeGreaterThan(0);
    expect(map.signals.summary).toContain("own 0 of");

    expect(map.recommendedCaseId?.startsWith("kitchen.")).toBe(true);
    expect(allCases.filter((mapCase) => mapCase.recommended)).toHaveLength(1);
  });

  it("lights a region as its chunks are practised and counts owned vs weak phrasings", async () => {
    await enroll("kitchen.meal_planning.whats_for_dinner", 3); // mastered
    await enroll("kitchen.meal_planning.feel_like", 1); // learning

    const map = await compileProgressMap(db, userA, t0);
    const kitchen = map.domains.find((domain) => domain.domain.id === "kitchen");
    const mealPlanning = kitchen?.cases.find(
      (mapCase) => mapCase.caseId === "kitchen.meal_planning"
    );

    expect(mealPlanning?.light).toBe("dim");
    expect(mealPlanning?.mastery.masteredChunks).toBe(1);
    expect(map.signals.ownedChunks).toBe(1);
    expect(map.signals.weakChunks).toBe(1);
  });

  it("includes the recurring-error trend", async () => {
    await depositTurnOutcome(
      { createId, db },
      { errorCategory: "article_drop", grade: 1 },
      userA,
      t0
    );
    await depositTurnOutcome(
      { createId, db },
      { errorCategory: "article_drop", grade: 1 },
      userA,
      t0
    );
    await depositTurnOutcome({ createId, db }, { errorCategory: "register", grade: 1 }, userA, t0);

    const map = await compileProgressMap(db, userA, t0);
    expect(map.signals.errorTrend[0]).toMatchObject({ category: "article_drop", count: 2 });
  });

  it("excludes a case still awaiting review", async () => {
    const outcome = await authorCase(
      {
        coach: createFakeCoach(),
        createCaseId: () => "authored-case",
        createChunkId: createId,
        db
      },
      {
        communicativeFunction: "Welcoming guests",
        domainId: "kitchen",
        situation: "A dinner party"
      }
    );
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }

    const map = await compileProgressMap(db, userA, t0);
    const allCaseIds = map.domains.flatMap((domain) =>
      domain.cases.map((mapCase) => mapCase.caseId)
    );
    expect(allCaseIds).not.toContain("authored-case");
  });
  it("handles a chunkless case and a caseless domain", async () => {
    await db
      .insert(domains)
      .values({ id: "d-empty", name: "Empty domain", orderIndex: 90, weight: 0.1 });
    await db
      .insert(domains)
      .values({ id: "d-bare", name: "Bare domain", orderIndex: 91, weight: 0.1 });
    await db.insert(cases).values({
      communicativeFunction: "f",
      domainId: "d-bare",
      id: "d-bare.case",
      orderIndex: 0,
      situation: "A case with no chunks yet"
    });

    const map = await compileProgressMap(db, userA, t0);
    const emptyDomain = map.domains.find((domain) => domain.domain.id === "d-empty");
    const bareDomain = map.domains.find((domain) => domain.domain.id === "d-bare");

    expect(emptyDomain?.cases).toEqual([]);
    expect(bareDomain?.cases).toHaveLength(1);
    expect(bareDomain?.cases[0]).toMatchObject({ light: "dark", mastery: { totalChunks: 0 } });
  });

  it("describes an empty world when no corpus is seeded", async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const emptyDb = createDbClient(pglite);
    try {
      const map = await compileProgressMap(emptyDb, userA, t0);
      expect(map.signals.totalChunks).toBe(0);
      expect(map.signals.summary).toContain("Your map is waiting");
      expect(map.recommendedCaseId).toBeNull();
    } finally {
      await emptyDb.$client.close();
    }
  });
});

describe("GET /api/progress-map", () => {
  it("returns the compiled map for the current user", async () => {
    const server = createServer({
      logger: createLoggerOptions("silent"),
      map: { db, now: () => t0 }
    });
    try {
      const response = await server.inject({ method: "GET", url: "/api/progress-map" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.domains)).toBe(true);
      expect(body.signals.totalChunks).toBeGreaterThan(0);
      expect(typeof body.signals.summary).toBe("string");
    } finally {
      await server.close();
    }
  });
});
