import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { cardCreationAttempts } from "../../db/schema.js";
import {
  consumeAttempt,
  discardPendingAttempt,
  expireCardCreationAttempts,
  fingerprintReviewCandidates,
  getCardCreationAttempt,
  getPendingAttemptForSubmission,
  insertPendingCardCreationAttempt,
  refreshAttemptReview,
  type CardCreationAttemptRecord
} from "./cardCreationAttemptStore.js";

const userId = "user-1";
const otherUser = "user-2";
const now = new Date("2026-03-01T08:00:00.000Z");
const ttlMs = 30 * 60 * 1000;

let db: DbClient;

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

async function seedPending(
  over: Partial<{
    exactNoteIds: ReadonlyArray<string>;
    nearNoteIds: ReadonlyArray<string>;
    nearKeys: ReadonlyArray<string>;
    expiresAt: Date;
    id: string;
    submissionId: string;
    userId: string;
    source: "ui" | "mcp";
    draftPayload: unknown;
  }> = {}
): Promise<CardCreationAttemptRecord> {
  return db.transaction((tx) =>
    insertPendingCardCreationAttempt(tx, {
      draftFingerprint: "draft-fp",
      draftPayload: (over.draftPayload as never) ?? null,
      exactNoteIds: over.exactNoteIds ?? ["note-a", "note-b"],
      expiresAt: over.expiresAt ?? new Date(now.getTime() + ttlMs),
      id: over.id ?? "attempt-1",
      nearKeys: over.nearKeys ?? [],
      nearNoteIds: over.nearNoteIds ?? [],
      now,
      source: over.source ?? "ui",
      submissionId: over.submissionId ?? "sub-1",
      userId: over.userId ?? userId
    })
  );
}

beforeEach(async () => {
  db = await buildDb();
});

describe("fingerprintReviewCandidates", () => {
  it("is order-sensitive within each group so a changed candidate set hashes differently", () => {
    const base = fingerprintReviewCandidates({
      exactNoteIds: ["a", "b"],
      nearKeys: [],
      nearNoteIds: []
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      fingerprintReviewCandidates({ exactNoteIds: ["a", "b"], nearKeys: [], nearNoteIds: [] })
    ).toBe(base);
    expect(
      fingerprintReviewCandidates({ exactNoteIds: ["b", "a"], nearKeys: [], nearNoteIds: [] })
    ).not.toBe(base);
    expect(
      fingerprintReviewCandidates({ exactNoteIds: ["a"], nearKeys: [], nearNoteIds: [] })
    ).not.toBe(base);
  });

  it("distinguishes the exact group from the near group and folds in near candidates", () => {
    // The same id in the exact vs the near group is a DIFFERENT reviewed set, so the fingerprints differ.
    const exactOnly = fingerprintReviewCandidates({
      exactNoteIds: ["a"],
      nearKeys: [],
      nearNoteIds: []
    });
    const nearOnly = fingerprintReviewCandidates({
      exactNoteIds: [],
      nearKeys: ["k"],
      nearNoteIds: ["a"]
    });
    const both = fingerprintReviewCandidates({
      exactNoteIds: ["a"],
      nearKeys: ["k"],
      nearNoteIds: ["b"]
    });
    expect(nearOnly).not.toBe(exactOnly);
    expect(both).not.toBe(exactOnly);
    expect(both).not.toBe(nearOnly);
  });

  it("binds near candidate content so a same-id edit of the reviewed wording hashes differently", () => {
    // #714 fence: two near candidates with the SAME id and order but different reviewed keys must hash
    // differently, so a same-id edit of a "Possible duplicate" candidate's wording re-parks the review even
    // though its note id never changed.
    const before = fingerprintReviewCandidates({
      exactNoteIds: [],
      nearKeys: ["in term of the design"],
      nearNoteIds: ["note-n"]
    });
    const after = fingerprintReviewCandidates({
      exactNoteIds: [],
      nearKeys: ["in terms of the designs"],
      nearNoteIds: ["note-n"]
    });
    expect(after).not.toBe(before);
  });
});

describe("insertPendingCardCreationAttempt", () => {
  it("persists a pending attempt with revision 0 and a derived candidate fingerprint", async () => {
    const record = await seedPending();
    expect(record).toMatchObject({
      candidateFingerprint: fingerprintReviewCandidates({
        exactNoteIds: ["note-a", "note-b"],
        nearKeys: [],
        nearNoteIds: []
      }),
      candidateNoteIds: ["note-a", "note-b"],
      decision: null,
      draftFingerprint: "draft-fp",
      draftPayload: null,
      id: "attempt-1",
      revision: 0,
      source: "ui",
      state: "pending",
      submissionId: "sub-1",
      userId
    });
  });

  it("records the raising source and stages the mcp draft payload verbatim", async () => {
    const payload = { answerDoc: { type: "doc" }, questionDoc: { type: "doc" }, target: "x" };
    const record = await seedPending({ source: "mcp", draftPayload: payload });
    expect(record.source).toBe("mcp");
    expect(record.draftPayload).toEqual(payload);

    // The staged payload round-trips through a fresh read, proving it is persisted, not just echoed.
    const reread = await getCardCreationAttempt(db, userId, "attempt-1");
    expect(reread?.source).toBe("mcp");
    expect(reread?.draftPayload).toEqual(payload);
  });

  it("stores the combined exact-then-near ids and binds both groups in the fingerprint", async () => {
    const record = await seedPending({
      exactNoteIds: ["note-a"],
      nearKeys: ["key-n"],
      nearNoteIds: ["note-n"]
    });
    expect(record.candidateNoteIds).toEqual(["note-a", "note-n"]);
    expect(record.candidateFingerprint).toBe(
      fingerprintReviewCandidates({
        exactNoteIds: ["note-a"],
        nearKeys: ["key-n"],
        nearNoteIds: ["note-n"]
      })
    );
    // A near-only match still binds an attempt whose fingerprint differs from the exact-only shape.
    expect(record.candidateFingerprint).not.toBe(
      fingerprintReviewCandidates({
        exactNoteIds: ["note-a", "note-n"],
        nearKeys: [],
        nearNoteIds: []
      })
    );
  });

  it("rejects a second pending attempt for the same owner and submission", async () => {
    await seedPending();
    await expect(seedPending({ id: "attempt-2" })).rejects.toThrow();
  });
});

describe("getPendingAttemptForSubmission", () => {
  it("returns the pending attempt for the owner and submission", async () => {
    await seedPending();
    const found = await getPendingAttemptForSubmission(db, userId, "sub-1");
    expect(found?.id).toBe("attempt-1");
  });

  it("returns null once the attempt is consumed", async () => {
    const record = await seedPending();
    await db.transaction((tx) =>
      consumeAttempt(tx, {
        decision: "reuse",
        expectedRevision: record.revision,
        id: record.id,
        now,
        userId
      })
    );
    expect(await getPendingAttemptForSubmission(db, userId, "sub-1")).toBeNull();
  });

  it("does not leak another owner's pending attempt", async () => {
    await seedPending();
    expect(await getPendingAttemptForSubmission(db, otherUser, "sub-1")).toBeNull();
  });
});

describe("getCardCreationAttempt", () => {
  it("returns the attempt scoped to its owner and id", async () => {
    await seedPending();
    expect((await getCardCreationAttempt(db, userId, "attempt-1"))?.id).toBe("attempt-1");
  });

  it("returns null for a cross-owner or unknown id", async () => {
    await seedPending();
    expect(await getCardCreationAttempt(db, otherUser, "attempt-1")).toBeNull();
    expect(await getCardCreationAttempt(db, userId, "missing")).toBeNull();
  });
});

describe("refreshAttemptReview", () => {
  it("bumps the revision and rewrites the candidate set at the expected revision", async () => {
    const record = await seedPending();
    const refreshed = await db.transaction((tx) =>
      refreshAttemptReview(tx, {
        exactNoteIds: ["note-c"],
        expectedRevision: record.revision,
        id: record.id,
        nearKeys: [],
        nearNoteIds: [],
        now,
        userId
      })
    );
    expect(refreshed).toMatchObject({
      candidateFingerprint: fingerprintReviewCandidates({
        exactNoteIds: ["note-c"],
        nearKeys: [],
        nearNoteIds: []
      }),
      candidateNoteIds: ["note-c"],
      revision: 1,
      state: "pending"
    });
  });

  it("misses at a stale revision, leaving the row untouched", async () => {
    const record = await seedPending();
    const missed = await db.transaction((tx) =>
      refreshAttemptReview(tx, {
        exactNoteIds: ["note-c"],
        expectedRevision: record.revision + 5,
        id: record.id,
        nearKeys: [],
        nearNoteIds: [],
        now,
        userId
      })
    );
    expect(missed).toBeNull();
    expect((await getCardCreationAttempt(db, userId, "attempt-1"))?.revision).toBe(0);
  });
});

describe("consumeAttempt", () => {
  it("compare-and-sets pending to consumed once, recording the decision", async () => {
    const record = await seedPending();
    const first = await db.transaction((tx) =>
      consumeAttempt(tx, {
        decision: "keep_separate",
        expectedRevision: record.revision,
        id: record.id,
        now,
        userId
      })
    );
    expect(first).toBe(true);

    const row = await db
      .select()
      .from(cardCreationAttempts)
      .where(eq(cardCreationAttempts.id, record.id));
    expect(row[0]).toMatchObject({ decision: "keep_separate", revision: 1, state: "consumed" });

    const second = await db.transaction((tx) =>
      consumeAttempt(tx, {
        decision: "reuse",
        expectedRevision: record.revision,
        id: record.id,
        now,
        userId
      })
    );
    expect(second).toBe(false);
  });
});

describe("discardPendingAttempt", () => {
  it("removes a pending attempt", async () => {
    const record = await seedPending();
    await db.transaction((tx) => discardPendingAttempt(tx, userId, record.id));
    expect(await getCardCreationAttempt(db, userId, record.id)).toBeNull();
  });

  it("leaves a consumed attempt in place", async () => {
    const record = await seedPending();
    await db.transaction((tx) =>
      consumeAttempt(tx, {
        decision: "reuse",
        expectedRevision: record.revision,
        id: record.id,
        now,
        userId
      })
    );
    await db.transaction((tx) => discardPendingAttempt(tx, userId, record.id));
    expect((await getCardCreationAttempt(db, userId, record.id))?.state).toBe("consumed");
  });
});

describe("expireCardCreationAttempts", () => {
  it("sweeps only attempts whose TTL has passed and reports the count", async () => {
    await seedPending({ id: "fresh", submissionId: "s-fresh" });
    await seedPending({
      id: "stale",
      submissionId: "s-stale",
      expiresAt: new Date(now.getTime() - 1)
    });

    const removed = await expireCardCreationAttempts(db, now);
    expect(removed).toBe(1);
    expect(await getCardCreationAttempt(db, userId, "fresh")).not.toBeNull();
    expect(await getCardCreationAttempt(db, userId, "stale")).toBeNull();
  });
});
