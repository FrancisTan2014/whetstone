import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthorCaseResult } from "@whetstone/contracts";

import { createFakeCoach } from "../../coach/fakeCoach.js";
import type { CoachProvider } from "../../coach/coachProvider.js";
import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { cases, chunks } from "../../db/schema.js";
import { seedCaseCorpus } from "../cases/caseSeed.js";
import { compileContext } from "../learner/learnerQueries.js";
import { authorCase, reviewCase, type AuthoringDependencies } from "./authoringCommands.js";
import { listCasesNeedingReview } from "./authoringQueries.js";

const brief = {
  communicativeFunction: "Welcoming guests",
  domainId: "kitchen",
  situation: "Hosting a dinner party"
};

let db: DbClient;

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const client = createDbClient(pglite);
  await seedCaseCorpus(client);
  return client;
}

// A coach that counts authorCase calls, to assert caching skips the model.
function countingCoach(): { calls: () => number; coach: CoachProvider } {
  const fake = createFakeCoach();
  let calls = 0;
  return {
    calls: () => calls,
    coach: {
      ...fake,
      authorCase: (input) => {
        calls += 1;
        return fake.authorCase(input);
      }
    }
  };
}

function makeDeps(coach: CoachProvider): AuthoringDependencies {
  let caseSeq = 0;
  let chunkSeq = 0;
  return {
    coach,
    createCaseId: () => `case-${(caseSeq += 1)}`,
    createChunkId: () => `chunk-${(chunkSeq += 1)}`,
    db
  };
}

beforeEach(async () => {
  db = await buildDb();
});

afterEach(async () => {
  await db.$client.close();
});

describe("authorCase", () => {
  it("authors a new case as needs_review with its chunk inventory", async () => {
    const outcome = await authorCase(makeDeps(createFakeCoach()), brief);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }

    expect(outcome.authored.cached).toBe(false);
    expect(outcome.authored.status).toBe("needs_review");
    expect(outcome.authored.case).toMatchObject({
      domainId: "kitchen",
      situation: brief.situation
    });
    expect(outcome.authored.chunks.length).toBeGreaterThan(0);

    const [persisted] = await db.select().from(cases).where(eq(cases.id, outcome.authored.case.id));
    expect(persisted?.status).toBe("needs_review");
    expect(persisted?.briefKey).not.toBeNull();
    const storedChunks = await db
      .select()
      .from(chunks)
      .where(eq(chunks.caseId, outcome.authored.case.id));
    expect(storedChunks).toHaveLength(outcome.authored.chunks.length);
  });

  it("caches: re-requesting the same brief reuses the stored case with no model call", async () => {
    const { calls, coach } = countingCoach();
    const deps = makeDeps(coach);

    const first = await authorCase(deps, brief);
    // Same brief modulo case + whitespace -> same cache key.
    const second = await authorCase(deps, {
      communicativeFunction: "  welcoming   GUESTS ",
      domainId: "kitchen",
      situation: "  Hosting a DINNER party  "
    });

    if (first.status !== "ok" || second.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(second.authored.cached).toBe(true);
    expect(second.authored.case.id).toBe(first.authored.case.id);
    expect(calls()).toBe(1);
  });

  it("returns domain_not_found for an unknown domain and never calls the model", async () => {
    const { calls, coach } = countingCoach();
    const outcome = await authorCase(makeDeps(coach), { ...brief, domainId: "nope" });
    expect(outcome).toEqual({ status: "domain_not_found" });
    expect(calls()).toBe(0);
  });

  it("persists a case even when the coach returns no chunks", async () => {
    const emptyCoach: CoachProvider = {
      ...createFakeCoach(),
      authorCase: (input): Promise<AuthorCaseResult> =>
        Promise.resolve({
          chunks: [],
          communicativeFunction: input.communicativeFunction,
          situation: input.situation
        })
    };
    const outcome = await authorCase(makeDeps(emptyCoach), brief);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.authored.chunks).toEqual([]);
    const [persisted] = await db.select().from(cases).where(eq(cases.id, outcome.authored.case.id));
    expect(persisted?.status).toBe("needs_review");
  });
});

describe("reviewCase", () => {
  async function authorOne(): Promise<string> {
    const outcome = await authorCase(makeDeps(createFakeCoach()), brief);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    return outcome.authored.case.id;
  }

  it("accepts an authored case as-is, activating it", async () => {
    const caseId = await authorOne();
    const outcome = await reviewCase(makeDeps(createFakeCoach()), caseId, {});
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.reviewed.status).toBe("active");
    expect(outcome.reviewed.case.situation).toBe(brief.situation);

    const [persisted] = await db.select().from(cases).where(eq(cases.id, caseId));
    expect(persisted?.status).toBe("active");
  });

  it("edits and activates", async () => {
    const caseId = await authorOne();
    const outcome = await reviewCase(makeDeps(createFakeCoach()), caseId, {
      communicativeFunction: "Greeting arrivals",
      situation: "Hosting a small gathering"
    });
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(outcome.reviewed.case).toMatchObject({
      communicativeFunction: "Greeting arrivals",
      situation: "Hosting a small gathering"
    });
    expect(outcome.reviewed.status).toBe("active");
  });

  it("returns not_found for an unknown case", async () => {
    expect(await reviewCase(makeDeps(createFakeCoach()), "nope", {})).toEqual({
      status: "not_found"
    });
  });
});

describe("listCasesNeedingReview", () => {
  it("lists authored cases awaiting review and drops them once accepted", async () => {
    const deps = makeDeps(createFakeCoach());
    const first = await authorCase(deps, brief);
    await authorCase(deps, { ...brief, situation: "Clearing the table" });
    if (first.status !== "ok") {
      throw new Error("expected ok");
    }

    // Seeded cases are active, so only the two authored cases are pending.
    expect(await listCasesNeedingReview(db)).toHaveLength(2);
    expect(await listCasesNeedingReview(db, "small_talk")).toEqual([]);

    await reviewCase(deps, first.authored.case.id, {});
    expect(await listCasesNeedingReview(db)).toHaveLength(1);
  });
});

describe("practice gating (#208 integration)", () => {
  it("excludes a needs_review case's chunks from compileContext until it is accepted", async () => {
    const outcome = await authorCase(makeDeps(createFakeCoach()), brief);
    if (outcome.status !== "ok") {
      throw new Error("expected ok");
    }
    const authoredChunkId = outcome.authored.chunks[0]?.id;

    const before = await compileContext(db, "user-a", new Date("2026-01-01T00:00:00.000Z"), {
      chunkLimit: 1000
    });
    expect(before.rankedChunks.some((chunk) => chunk.chunkId === authoredChunkId)).toBe(false);

    await reviewCase(makeDeps(createFakeCoach()), outcome.authored.case.id, {});

    const after = await compileContext(db, "user-a", new Date("2026-01-01T00:00:00.000Z"), {
      chunkLimit: 1000
    });
    expect(after.rankedChunks.some((chunk) => chunk.chunkId === authoredChunkId)).toBe(true);
  });
});
