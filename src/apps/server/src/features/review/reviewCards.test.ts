import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, reviewCards, reviewEvents } from "../../db/schema.js";
import {
  deleteReviewCard,
  deleteReviewCardsAndEvents,
  pauseReviewCard,
  rateReviewCard,
  restartReviewCard,
  resumeReviewCard,
  seedReviewCard,
  snoozeReviewCard,
  type ReviewCardDependencies
} from "./reviewCardCommands.js";
import {
  getReviewCardForUser,
  reviewStateColumns,
  reviewStateFromCard
} from "./reviewCardQueries.js";

const userA = "user-a";
const userB = "user-b";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{ db: DbClient; deps: ReviewCardDependencies }>;
let context: TestContext;

function buildDeps(db: DbClient): ReviewCardDependencies {
  let sequence = 0;
  return { createId: () => `event-${(sequence += 1)}`, db };
}

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  return { db, deps: buildDeps(db) };
}

// Every card FK's `target_entry_id` must resolve to a real Entry; seed a minimal one.
async function seedTargetEntry(id: string): Promise<void> {
  await context.db.insert(entries).values({ id, type: "note" }).onConflictDoNothing();
}

async function seedCard(
  targetEntryId: string,
  userId: string,
  now: Date,
  requestedRetention = RECALL_REQUEST_RETENTION
): Promise<void> {
  await seedTargetEntry(targetEntryId);
  await context.db.transaction((tx) =>
    seedReviewCard(tx, { targetEntryId, userId, requestedRetention, now })
  );
}

async function eventsFor(
  targetEntryId: string
): Promise<ReadonlyArray<typeof reviewEvents.$inferSelect>> {
  return context.db
    .select()
    .from(reviewEvents)
    .where(eq(reviewEvents.targetEntryId, targetEntryId));
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("seedReviewCard", () => {
  it("inserts an active card with a fresh state due at `now`, and returns that state", async () => {
    await seedTargetEntry("t1");
    const state = await context.db.transaction((tx) =>
      seedReviewCard(tx, {
        targetEntryId: "t1",
        userId: userA,
        requestedRetention: 0.95,
        now: t0
      })
    );

    expect(state).toEqual(newReviewState(t0));

    const card = await getReviewCardForUser(context.db, "t1", userA);
    expect(card?.status).toBe("active");
    expect(card?.requestedRetention).toBe(0.95);
    expect(card?.userId).toBe(userA);
    // The card row round-trips back to the same domain state.
    expect(reviewStateFromCard(card!)).toEqual(state);
    expect(card?.dueAt).toEqual(t0);
    expect(card?.lastReviewedAt).toBeNull();
  });

  it("rejects an out-of-range requested retention (validated at the boundary)", async () => {
    await seedTargetEntry("t-bad");
    await expect(
      context.db.transaction((tx) =>
        seedReviewCard(tx, {
          targetEntryId: "t-bad",
          userId: userA,
          requestedRetention: 1,
          now: t0
        })
      )
    ).rejects.toThrow(RangeError);
    expect(await getReviewCardForUser(context.db, "t-bad", userA)).toBeUndefined();
  });
});

describe("rateReviewCard", () => {
  it("advances the card and appends exactly one rating event atomically", async () => {
    await seedCard("t1", userA, t0);

    const result = await rateReviewCard(context.deps, "t1", userA, "good", at(1));
    expect(result.status).toBe("rated");
    if (result.status !== "rated") {
      return;
    }
    expect(result.state.reps).toBe(1);
    expect(result.card.reps).toBe(1);
    expect(result.card.updatedAt).toEqual(at(1));

    const card = await getReviewCardForUser(context.db, "t1", userA);
    expect(card?.reps).toBe(1);
    expect(reviewStateFromCard(card!)).toEqual(result.state);

    const events = await eventsFor("t1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "rating", rating: "good", targetEntryId: "t1" });
    expect(events[0]?.occurredAt).toEqual(at(1));
  });

  it("schedules with the card's own stored requested retention", async () => {
    await seedCard("low", userA, t0, 0.9);
    await seedCard("high", userA, t0, 0.97);

    const low = await rateReviewCard(context.deps, "low", userA, "easy", t0);
    const high = await rateReviewCard(context.deps, "high", userA, "easy", t0);
    if (low.status !== "rated" || high.status !== "rated") {
      throw new Error("expected both rated");
    }
    // A higher requested retention shortens the next interval.
    expect(high.state.scheduledDays).toBeLessThan(low.state.scheduledDays);
  });

  it("is not_found for a missing card or another user's card, appending no event", async () => {
    await seedCard("t1", userA, t0);

    expect(await rateReviewCard(context.deps, "missing", userA, "good", t0)).toEqual({
      status: "not_found"
    });
    expect(await rateReviewCard(context.deps, "t1", userB, "good", t0)).toEqual({
      status: "not_found"
    });
    expect(await eventsFor("t1")).toHaveLength(0);
    // The other user's rating left the card untouched.
    expect((await getReviewCardForUser(context.db, "t1", userA))?.reps).toBe(0);
  });
});

describe("restartReviewCard", () => {
  it("resets the card to a fresh state and appends exactly one reset event (no rating)", async () => {
    await seedCard("t1", userA, t0);
    await rateReviewCard(context.deps, "t1", userA, "good", at(1));

    const result = await restartReviewCard(context.deps, "t1", userA, at(5));
    expect(result.status).toBe("restarted");
    if (result.status !== "restarted") {
      return;
    }
    expect(result.state).toEqual(newReviewState(at(5)));

    const card = await getReviewCardForUser(context.db, "t1", userA);
    expect(card?.reps).toBe(0);
    expect(card?.state).toBe("new");
    // Its owner and requested retention are preserved through the restart.
    expect(card?.requestedRetention).toBe(RECALL_REQUEST_RETENTION);

    const events = await eventsFor("t1");
    expect(events).toHaveLength(2);
    const reset = events.find((event) => event.type === "reset");
    expect(reset?.rating).toBeNull();
    expect(reset?.occurredAt).toEqual(at(5));
  });

  it("is not_found for another user's card, appending no event", async () => {
    await seedCard("t1", userA, t0);
    expect(await restartReviewCard(context.deps, "t1", userB, t0)).toEqual({ status: "not_found" });
    expect(await eventsFor("t1")).toHaveLength(0);
  });
});

describe("snoozeReviewCard", () => {
  it("moves only the due date forward, leaving FSRS state and history untouched", async () => {
    await seedCard("t1", userA, t0);

    const result = await snoozeReviewCard(context.db, "t1", userA, at(3));
    expect(result.status).toBe("updated");
    if (result.status !== "updated") {
      return;
    }
    expect(result.card.dueAt).toEqual(at(4));

    const card = await getReviewCardForUser(context.db, "t1", userA);
    expect(card?.dueAt).toEqual(at(4));
    expect(card?.reps).toBe(0);
    expect(card?.state).toBe("new");
    expect(await eventsFor("t1")).toHaveLength(0);
  });

  it("honours a custom defer window", async () => {
    await seedCard("t1", userA, t0);
    await snoozeReviewCard(context.db, "t1", userA, t0, 7);
    expect((await getReviewCardForUser(context.db, "t1", userA))?.dueAt).toEqual(at(7));
  });

  it("is not_found for another user's card", async () => {
    await seedCard("t1", userA, t0);
    expect(await snoozeReviewCard(context.db, "t1", userB, t0)).toEqual({ status: "not_found" });
  });
});

describe("pauseReviewCard / resumeReviewCard", () => {
  it("toggles status without touching FSRS state or appending events", async () => {
    await seedCard("t1", userA, t0);

    const paused = await pauseReviewCard(context.db, "t1", userA, at(1));
    expect(paused.status).toBe("updated");
    expect((await getReviewCardForUser(context.db, "t1", userA))?.status).toBe("paused");

    const resumed = await resumeReviewCard(context.db, "t1", userA, at(2));
    expect(resumed.status).toBe("updated");
    const card = await getReviewCardForUser(context.db, "t1", userA);
    expect(card?.status).toBe("active");
    expect(card?.reps).toBe(0);
    expect(await eventsFor("t1")).toHaveLength(0);
  });

  it("is not_found for another user's card", async () => {
    await seedCard("t1", userA, t0);
    expect(await pauseReviewCard(context.db, "t1", userB, t0)).toEqual({ status: "not_found" });
    expect(await resumeReviewCard(context.db, "t1", userB, t0)).toEqual({ status: "not_found" });
  });
});

describe("deleteReviewCard", () => {
  it("drops the card but leaves its append-only events intact", async () => {
    await seedCard("t1", userA, t0);
    await rateReviewCard(context.deps, "t1", userA, "good", at(1));

    await context.db.transaction((tx) => deleteReviewCard(tx, "t1"));

    expect(await getReviewCardForUser(context.db, "t1", userA)).toBeUndefined();
    // History survives, so a later re-seed keeps the target's past record.
    expect(await eventsFor("t1")).toHaveLength(1);
  });
});

describe("deleteReviewCardsAndEvents", () => {
  it("removes both the cards and the events for the given targets", async () => {
    await seedCard("t1", userA, t0);
    await seedCard("t2", userA, t0);
    await rateReviewCard(context.deps, "t1", userA, "good", at(1));
    await rateReviewCard(context.deps, "t2", userA, "again", at(1));

    await context.db.transaction((tx) => deleteReviewCardsAndEvents(tx, ["t1", "t2"]));

    expect(await context.db.select().from(reviewCards)).toHaveLength(0);
    expect(await context.db.select().from(reviewEvents)).toHaveLength(0);
  });

  it("is a no-op for an empty target list", async () => {
    await seedCard("t1", userA, t0);
    await rateReviewCard(context.deps, "t1", userA, "good", at(1));

    await context.db.transaction((tx) => deleteReviewCardsAndEvents(tx, []));

    expect(await getReviewCardForUser(context.db, "t1", userA)).toBeDefined();
    expect(await eventsFor("t1")).toHaveLength(1);
  });
});

describe("reviewStateColumns / reviewStateFromCard", () => {
  it("round-trips a null and a non-null last-reviewed instant", async () => {
    const fresh = newReviewState(t0);
    expect(reviewStateColumns(fresh).lastReviewedAt).toBeNull();

    await seedCard("t1", userA, t0);
    const reviewed = await rateReviewCard(context.deps, "t1", userA, "good", at(1));
    if (reviewed.status !== "rated") {
      throw new Error("expected rated");
    }
    // After a review the card carries a non-null last-reviewed instant that round-trips.
    expect(reviewed.state.lastReviewedAt).toBe(at(1).toISOString());
    const columns = reviewStateColumns(reviewed.state);
    expect(columns.lastReviewedAt).toEqual(at(1));
  });
});
