import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnrollRecallItemRequest } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, recallReviews } from "../../db/schema.js";
import { enrollRecallItem, recordRecallReview, type RecallDependencies } from "./recallCommands.js";
import { listDueRecallItems, listRecallItems, searchRecallItems } from "./recallQueries.js";

const userA = "user-a";
const userB = "user-b";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{ db: DbClient; deps: RecallDependencies }>;
let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  let sequence = 0;
  return { db, deps: { createId: () => `id-${(sequence += 1)}`, db } };
}

function enroll(
  request: EnrollRecallItemRequest,
  userId: string,
  now: Date
): ReturnType<typeof enrollRecallItem> {
  return enrollRecallItem(context.deps, request, userId, now);
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("enrollRecallItem", () => {
  it("seeds a fresh SM-2 review state, due immediately, with no provenance or gloss", async () => {
    const item = await enroll({ kind: "idiom", text: "spill the beans" }, userA, t0);

    expect(item).toEqual({
      chunkId: null,
      createdAt: t0.toISOString(),
      gloss: null,
      id: "id-1",
      kind: "idiom",
      provenanceEntryId: null,
      review: {
        dueAt: t0.toISOString(),
        easeFactor: 2.5,
        intervalDays: 0,
        lapses: 0,
        lastReviewedAt: null,
        repetitions: 0
      },
      text: "spill the beans"
    });
  });

  it("keeps a gloss and a provenance link to a source entry", async () => {
    await context.db.insert(entries).values({ id: "note-1", type: "note" });

    const item = await enroll(
      {
        gloss: "to reveal a secret",
        kind: "phrase",
        provenanceEntryId: "note-1",
        text: "spill it"
      },
      userA,
      t0
    );

    expect(item.gloss).toBe("to reveal a secret");
    expect(item.provenanceEntryId).toBe("note-1");
  });
});

describe("recordRecallReview", () => {
  it("applies SM-2, persists the new state, and appends a history row", async () => {
    const enrolled = await enroll({ kind: "word", text: "quick" }, userA, t0);

    const first = await recordRecallReview(context.deps, enrolled.id, 4, userA, at(1));
    expect(first).toMatchObject({
      status: "recorded",
      item: { review: { intervalDays: 1, repetitions: 1, lapses: 0 } }
    });
    if (first.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(first.item.review.lastReviewedAt).toBe(at(1).toISOString());
    expect(first.item.review.dueAt).toBe(at(2).toISOString());

    // A second review reads back a row whose lastReviewedAt is already set (non-null path).
    const second = await recordRecallReview(context.deps, enrolled.id, 4, userA, at(2));
    if (second.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(second.item.review.repetitions).toBe(2);
    expect(second.item.review.intervalDays).toBe(6);

    // The persisted item reflects the latest state.
    const [persisted] = await listRecallItems(context.db, userA);
    expect(persisted?.review.repetitions).toBe(2);

    // Both reviews are logged in history.
    const history = await context.db
      .select()
      .from(recallReviews)
      .where(eq(recallReviews.recallItemId, enrolled.id));
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.grade).sort()).toEqual([4, 4]);
  });

  it("returns not_found for a missing item", async () => {
    expect(await recordRecallReview(context.deps, "nope", 4, userA, t0)).toEqual({
      status: "not_found"
    });
  });

  it("returns not_found for another user's item and leaves it unchanged", async () => {
    const enrolled = await enroll({ kind: "word", text: "quick" }, userA, t0);

    expect(await recordRecallReview(context.deps, enrolled.id, 4, userB, t0)).toEqual({
      status: "not_found"
    });

    const [item] = await listRecallItems(context.db, userA);
    expect(item?.review.repetitions).toBe(0);
  });
});

describe("listDueRecallItems", () => {
  it("returns only the user's due items, soonest first, capped by the limit", async () => {
    const early = await enroll({ kind: "word", text: "early" }, userA, at(-2));
    const mid = await enroll({ kind: "word", text: "mid" }, userA, at(-1));
    const late = await enroll({ kind: "word", text: "late" }, userA, at(0));
    await enroll({ kind: "word", text: "other-user" }, userB, at(-2));

    const due = await listDueRecallItems(context.db, userA, at(0), 10);
    expect(due.map((d) => d.id)).toEqual([early.id, mid.id, late.id]);

    // Reviewing `early` pushes its due date into the future, so it drops out of the due list.
    await recordRecallReview(context.deps, early.id, 4, userA, at(0));
    const afterReview = await listDueRecallItems(context.db, userA, at(0), 10);
    expect(afterReview.map((d) => d.id)).toEqual([mid.id, late.id]);

    expect(await listDueRecallItems(context.db, userA, at(0), 1)).toHaveLength(1);
  });
});

describe("listRecallItems", () => {
  it("returns the user's whole set newest-first, isolated from other users", async () => {
    const older = await enroll({ kind: "word", text: "older" }, userA, at(0));
    const newer = await enroll({ kind: "word", text: "newer" }, userA, at(1));
    await enroll({ kind: "word", text: "b-item" }, userB, at(0));

    expect((await listRecallItems(context.db, userA)).map((i) => i.id)).toEqual([
      newer.id,
      older.id
    ]);
    expect((await listRecallItems(context.db, userB)).map((i) => i.text)).toEqual(["b-item"]);
  });
});

describe("searchRecallItems", () => {
  beforeEach(async () => {
    await enroll(
      { gloss: "to reveal a secret", kind: "idiom", text: "spill the beans" },
      userA,
      t0
    );
    await enroll({ kind: "phrase", text: "by and large" }, userA, t0);
    await enroll({ kind: "phrase", text: "100% sure" }, userA, t0);
    await enroll({ kind: "idiom", text: "spill the beans" }, userB, t0);
  });

  it("matches text case-insensitively", async () => {
    const results = await searchRecallItems(context.db, userA, "BEANS");
    expect(results.map((r) => r.text)).toEqual(["spill the beans"]);
  });

  it("matches the gloss", async () => {
    const results = await searchRecallItems(context.db, userA, "secret");
    expect(results.map((r) => r.text)).toEqual(["spill the beans"]);
  });

  it("treats LIKE metacharacters literally", async () => {
    const results = await searchRecallItems(context.db, userA, "100%");
    expect(results.map((r) => r.text)).toEqual(["100% sure"]);
  });

  it("is scoped to the user and returns nothing for a non-match", async () => {
    expect((await searchRecallItems(context.db, userA, "spill")).map((r) => r.text)).toEqual([
      "spill the beans"
    ]);
    expect(await searchRecallItems(context.db, userA, "zzz")).toEqual([]);
  });
});
