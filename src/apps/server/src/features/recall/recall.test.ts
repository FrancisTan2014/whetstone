import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnrollRecallItemRequest } from "@whetstone/contracts";
import { applyRating, newReviewState } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, recallReviews } from "../../db/schema.js";
import {
  enrollRecallItem,
  recordRecallReview,
  snoozeRecallItem,
  type RecallDependencies
} from "./recallCommands.js";
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
  it("seeds a fresh FSRS review state, due immediately, with no provenance or gloss", async () => {
    const item = await enroll({ kind: "idiom", text: "spill the beans" }, userA, t0);

    expect(item).toEqual({
      chunkId: null,
      createdAt: t0.toISOString(),
      gloss: null,
      id: "id-1",
      kind: "idiom",
      provenanceEntryId: null,
      review: newReviewState(t0),
      text: "spill the beans",
      cue: null,
      useContext: null,
      category: null,
      tags: null,
      sourceProposalCandidateId: null
    });

    // A freshly enrolled card is New, due immediately, with no reviews yet.
    expect(item.review.state).toBe("new");
    expect(item.review.due).toBe(t0.toISOString());
    expect(item.review.reps).toBe(0);
    expect(item.review.lapses).toBe(0);
    expect(item.review.lastReviewedAt).toBeNull();
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

describe("enrollRecallItem gloss autofill (#526)", () => {
  function depsWithGlosser(
    resolveOfflineGloss: (text: string) => Promise<string | null>
  ): RecallDependencies {
    let sequence = 0;
    return { createId: () => `id-${(sequence += 1)}`, db: context.db, resolveOfflineGloss };
  }

  it("auto-fills a bare word's gloss from the offline glosser", async () => {
    const seen: string[] = [];
    const deps = depsWithGlosser(async (text) => {
      seen.push(text);
      return "noun: a lessening";
    });

    const item = await enrollRecallItem(deps, { kind: "word", text: "mitigation" }, userA, t0);

    expect(item.gloss).toBe("noun: a lessening");
    expect(seen).toEqual(["mitigation"]);
  });

  it("auto-fills a bare phrase's gloss the same way", async () => {
    const deps = depsWithGlosser(async () => "to reveal a secret");

    const item = await enrollRecallItem(
      deps,
      { kind: "phrase", text: "spill the beans" },
      userA,
      t0
    );

    expect(item.gloss).toBe("to reveal a secret");
  });

  it("preserves a caller-supplied gloss and never calls the glosser", async () => {
    const seen: string[] = [];
    const deps = depsWithGlosser(async (text) => {
      seen.push(text);
      return "autofilled";
    });

    const item = await enrollRecallItem(
      deps,
      { kind: "word", text: "mitigation", gloss: "my own note" },
      userA,
      t0
    );

    expect(item.gloss).toBe("my own note");
    expect(seen).toEqual([]);
  });

  it("does not auto-fill a kind outside word/phrase", async () => {
    const seen: string[] = [];
    const deps = depsWithGlosser(async (text) => {
      seen.push(text);
      return "autofilled";
    });

    const item = await enrollRecallItem(
      deps,
      { kind: "idiom", text: "spill the beans" },
      userA,
      t0
    );

    expect(item.gloss).toBeNull();
    expect(seen).toEqual([]);
  });

  it("enrolls with a null gloss when the glosser does not know the term", async () => {
    const deps = depsWithGlosser(async () => null);

    const item = await enrollRecallItem(deps, { kind: "word", text: "unknownium" }, userA, t0);

    expect(item.gloss).toBeNull();
  });

  it("leaves the gloss null when no glosser is wired", async () => {
    const item = await enroll({ kind: "word", text: "mitigation" }, userA, t0);

    expect(item.gloss).toBeNull();
  });
});

describe("recordRecallReview", () => {
  it("applies FSRS, persists the new state losslessly, and appends a history row", async () => {
    const enrolled = await enroll({ kind: "word", text: "quick" }, userA, t0);

    // The recorded state must equal the pure domain scheduler's output for the same card + rating.
    const expectedFirst = applyRating(newReviewState(t0), "good", at(1));
    const first = await recordRecallReview(context.deps, enrolled.id, "good", userA, at(1));
    if (first.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(first.item.review).toEqual(expectedFirst);
    // A "good" answer graduates a fresh card out of New, records the review, and advances due.
    expect(first.item.review.state).toBe("learning");
    expect(first.item.review.reps).toBe(1);
    expect(first.item.review.lapses).toBe(0);
    expect(first.item.review.lastReviewedAt).toBe(at(1).toISOString());
    expect(new Date(first.item.review.due).getTime()).toBeGreaterThan(at(1).getTime());

    // The persisted row round-trips losslessly (row -> ReviewState equals what was returned).
    const [afterFirst] = await listRecallItems(context.db, userA);
    expect(afterFirst?.review).toEqual(expectedFirst);

    // A second review reads back a row whose lastReviewedAt is already set (non-null path) and
    // advances reps again.
    const expectedSecond = applyRating(expectedFirst, "good", at(2));
    const second = await recordRecallReview(context.deps, enrolled.id, "good", userA, at(2));
    if (second.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(second.item.review).toEqual(expectedSecond);
    expect(second.item.review.reps).toBe(2);

    // The persisted item reflects the latest state, losslessly.
    const [persisted] = await listRecallItems(context.db, userA);
    expect(persisted?.review).toEqual(expectedSecond);

    // Both reviews are logged in history, carrying the rating (not a numeric grade).
    const history = await context.db
      .select()
      .from(recallReviews)
      .where(eq(recallReviews.recallItemId, enrolled.id));
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.rating).sort()).toEqual(["good", "good"]);
  });

  it("counts a lapse when a graduated card is failed with Again", async () => {
    const enrolled = await enroll({ kind: "word", text: "lapse" }, userA, t0);

    // Easy graduates the new card to Review; a following Again lapses it into Relearning.
    const reviewed = await recordRecallReview(context.deps, enrolled.id, "easy", userA, at(1));
    if (reviewed.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(reviewed.item.review.state).toBe("review");
    expect(reviewed.item.review.lapses).toBe(0);

    const lapsed = await recordRecallReview(context.deps, enrolled.id, "again", userA, at(2));
    if (lapsed.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(lapsed.item.review.state).toBe("relearning");
    expect(lapsed.item.review.lapses).toBe(1);
    expect(lapsed.item.review.reps).toBe(2);
  });

  it("returns not_found for a missing item", async () => {
    expect(await recordRecallReview(context.deps, "nope", "good", userA, t0)).toEqual({
      status: "not_found"
    });
  });

  it("returns not_found for another user's item and leaves it unchanged", async () => {
    const enrolled = await enroll({ kind: "word", text: "quick" }, userA, t0);

    expect(await recordRecallReview(context.deps, enrolled.id, "good", userB, t0)).toEqual({
      status: "not_found"
    });

    const [item] = await listRecallItems(context.db, userA);
    expect(item?.review).toEqual(newReviewState(t0));
    expect(item?.review.reps).toBe(0);
  });
});

describe("snoozeRecallItem", () => {
  it("moves only the due date forward a day, leaving the FSRS state untouched", async () => {
    const enrolled = await enroll({ kind: "word", text: "later" }, userA, t0);

    const result = await snoozeRecallItem(context.db, userA, enrolled.id, at(3));
    if (result.status !== "snoozed") {
      throw new Error("expected snoozed");
    }
    // Every FSRS field is the freshly-seeded card's; only `due` moved to now + 1 day.
    expect(result.item.review).toEqual({ ...newReviewState(t0), due: at(4).toISOString() });

    const [persisted] = await listRecallItems(context.db, userA);
    expect(persisted?.review.due).toBe(at(4).toISOString());
    expect(persisted?.review.reps).toBe(0);
    expect(persisted?.review.state).toBe("new");
  });

  it("returns not_found for a missing item", async () => {
    expect(await snoozeRecallItem(context.db, userA, "nope", t0)).toEqual({ status: "not_found" });
  });

  it("returns not_found for another user's item and leaves it unchanged", async () => {
    const enrolled = await enroll({ kind: "word", text: "later" }, userA, t0);

    expect(await snoozeRecallItem(context.db, userB, enrolled.id, at(3))).toEqual({
      status: "not_found"
    });

    const [item] = await listRecallItems(context.db, userA);
    expect(item?.review.due).toBe(t0.toISOString());
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
    await recordRecallReview(context.deps, early.id, "good", userA, at(0));
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
