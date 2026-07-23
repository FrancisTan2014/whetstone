import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { fingerprintReviewedCandidates, type ReviewedCandidateSnapshot } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { workCreationAttempts } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import {
  InvalidStageOwnershipError,
  beginFinalizeAttempt,
  cancelAttempt,
  clearStagePath,
  completeAttempt,
  detachStagePath,
  expireAttempts,
  getActiveAttemptForUser,
  getAttempt,
  insertPendingAttempt,
  updateAttemptReview,
  type InsertPendingAttemptInput
} from "./workCreationAttemptStore.js";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:05:00.000Z");
const EXPIRES = new Date("2026-02-01T01:00:00.000Z");
const OTHER_USER = "user-other";

const proposal = {
  title: "Designing Data-Intensive Applications",
  authorId: "author-1",
  authorName: "Martin Kleppmann",
  language: "en",
  workType: "book"
} as const;

const candidates: ReviewedCandidateSnapshot = [
  {
    entryId: "work-1",
    title: "Designing Data Intensive Applications",
    authorId: "author-1",
    authorName: "Martin Kleppmann",
    language: "en",
    workType: "book"
  }
];

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

function pendingInput(
  overrides: Partial<InsertPendingAttemptInput> = {}
): InsertPendingAttemptInput {
  return {
    id: overrides.id ?? "attempt-1",
    userId: overrides.userId ?? DEFAULT_USER_ID,
    proposed: overrides.proposed ?? proposal,
    sourceKind: overrides.sourceKind ?? "markdown",
    sourceHash: "sourceHash" in overrides ? overrides.sourceHash! : "a".repeat(64),
    candidates: "candidates" in overrides ? overrides.candidates! : candidates,
    stagePath: "stagePath" in overrides ? overrides.stagePath! : "stage-attempt-1",
    expiresAt: overrides.expiresAt ?? EXPIRES,
    now: overrides.now ?? NOW
  };
}

describe("workCreationAttemptStore", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  it("creates a pending attempt, computing the candidate fingerprint from the snapshot", async () => {
    const record = await insertPendingAttempt(db, pendingInput());

    expect(record.state).toBe("pending");
    expect(record.revision).toBe(0);
    expect(record.stagePath).toBe("stage-attempt-1");
    expect(record.candidateSnapshot).toEqual(candidates);
    expect(record.candidateFingerprint).toBe(fingerprintReviewedCandidates(candidates));
    expect(record.sourceHash).toBe("a".repeat(64));
  });

  it("stores no fingerprint when no candidates were reviewed", async () => {
    const record = await insertPendingAttempt(
      db,
      pendingInput({ candidates: null, sourceKind: "manual", sourceHash: null, stagePath: null })
    );

    expect(record.candidateSnapshot).toBeNull();
    expect(record.candidateFingerprint).toBeNull();
  });

  it("refuses a stage on a source kind that does not own an ordinary upload", async () => {
    await expect(
      insertPendingAttempt(db, pendingInput({ sourceKind: "manual", stagePath: "stage-x" }))
    ).rejects.toBeInstanceOf(InvalidStageOwnershipError);
    await expect(
      insertPendingAttempt(db, pendingInput({ sourceKind: "pdf", stagePath: "stage-y" }))
    ).rejects.toBeInstanceOf(InvalidStageOwnershipError);
  });

  it("enforces at most one active attempt per owner", async () => {
    await insertPendingAttempt(db, pendingInput({ id: "a1" }));
    await expect(insertPendingAttempt(db, pendingInput({ id: "a2" }))).rejects.toThrow();
    // A different owner is unaffected by the per-owner active constraint.
    await insertPendingAttempt(db, pendingInput({ id: "a3", userId: OTHER_USER }));
  });

  it("loads an attempt only for its owner (forged owner ids see nothing)", async () => {
    await insertPendingAttempt(db, pendingInput({ id: "a1" }));

    expect(await getAttempt(db, DEFAULT_USER_ID, "a1")).not.toBeNull();
    expect(await getAttempt(db, OTHER_USER, "a1")).toBeNull();
    expect(await getAttempt(db, DEFAULT_USER_ID, "missing")).toBeNull();
  });

  it("returns the owner's single active attempt, or null when none is active", async () => {
    expect(await getActiveAttemptForUser(db, DEFAULT_USER_ID)).toBeNull();

    await insertPendingAttempt(db, pendingInput({ id: "a1" }));
    const active = await getActiveAttemptForUser(db, DEFAULT_USER_ID);
    expect(active?.id).toBe("a1");

    await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER);
    expect(await getActiveAttemptForUser(db, DEFAULT_USER_ID)).toBeNull();
  });

  describe("updateAttemptReview", () => {
    it("re-fingerprints changed evidence and bumps the revision under the loaded revision", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));
      const changed: ReviewedCandidateSnapshot = [
        { ...candidates[0]!, title: "Designing Data-Intensive Applications, Revised" }
      ];

      const updated = await updateAttemptReview(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        proposed: proposal,
        candidates: changed,
        now: LATER
      });

      expect(updated?.revision).toBe(1);
      expect(updated?.candidateFingerprint).toBe(fingerprintReviewedCandidates(changed));
      expect(updated?.candidateFingerprint).not.toBe(fingerprintReviewedCandidates(candidates));
    });

    it("can clear reviewed evidence back to none", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));
      const updated = await updateAttemptReview(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        proposed: proposal,
        candidates: null,
        now: LATER
      });
      expect(updated?.candidateSnapshot).toBeNull();
      expect(updated?.candidateFingerprint).toBeNull();
    });

    it("rejects a stale revision, a foreign owner, and a non-pending attempt", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));

      const base = {
        id: "a1",
        proposed: proposal,
        candidates,
        now: LATER
      } as const;

      // Wrong (stale) revision.
      expect(
        await updateAttemptReview(db, { ...base, userId: DEFAULT_USER_ID, expectedRevision: 5 })
      ).toBeNull();
      // Foreign owner.
      expect(
        await updateAttemptReview(db, { ...base, userId: OTHER_USER, expectedRevision: 0 })
      ).toBeNull();

      // Once finalizing, review updates are rejected.
      await beginFinalizeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        now: LATER
      });
      expect(
        await updateAttemptReview(db, { ...base, userId: DEFAULT_USER_ID, expectedRevision: 1 })
      ).toBeNull();
    });
  });

  describe("finalization fencing", () => {
    it("serializes the decision: begin claims the slot, complete resolves it", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));

      const finalizing = await beginFinalizeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        now: LATER
      });
      expect(finalizing?.state).toBe("finalizing");
      expect(finalizing?.revision).toBe(1);

      const completed = await completeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 1,
        now: LATER
      });
      expect(completed?.state).toBe("completed");
      expect(completed?.revision).toBe(2);
    });

    it("rejects a replayed begin and a second concurrent committer", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));

      const first = await beginFinalizeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        now: LATER
      });
      expect(first).not.toBeNull();

      // A second client that still holds revision 0 cannot claim the slot again.
      expect(
        await beginFinalizeAttempt(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 0,
          now: LATER
        })
      ).toBeNull();
    });

    it("rejects completing from pending and rejects a double completion", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));

      // Cannot complete an attempt that never entered finalizing.
      expect(
        await completeAttempt(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 0,
          now: LATER
        })
      ).toBeNull();

      await beginFinalizeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        now: LATER
      });
      expect(
        await completeAttempt(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 1,
          now: LATER
        })
      ).not.toBeNull();
      // The same completion replayed at the old revision is rejected.
      expect(
        await completeAttempt(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 1,
          now: LATER
        })
      ).toBeNull();
    });
  });

  describe("cancellation", () => {
    it("cancels an active attempt and returns its owned stage for cleanup", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1", stagePath: "stage-a1" }));

      const result = await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER);
      expect(result).toEqual({ cancelled: true, stagePath: "stage-a1" });

      const record = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(record?.state).toBe("cancelled");
      // The stage path is kept until cleanup confirms removal.
      expect(record?.stagePath).toBe("stage-a1");
    });

    it("is a no-op on a terminal attempt or a foreign owner", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1" }));
      await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER);

      expect(await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER)).toEqual({
        cancelled: false,
        stagePath: null
      });
      expect(await cancelAttempt(db, OTHER_USER, "a1", LATER)).toEqual({
        cancelled: false,
        stagePath: null
      });
    });

    it("does not clobber an attempt that already completed (fenced on the active state)", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1", stagePath: "stage-a1" }));
      await beginFinalizeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 0,
        now: LATER
      });
      await completeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 1,
        now: LATER
      });

      // A cancel arriving after the attempt already reached a terminal state must be a no-op — it can
      // never overwrite `completed` with `cancelled`, the race the read-then-blind-write update allowed.
      expect(await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER)).toEqual({
        cancelled: false,
        stagePath: null
      });
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.state).toBe("completed");
    });
  });

  describe("expiry sweep", () => {
    it("expires only past-TTL active attempts and returns their owned stages", async () => {
      await insertPendingAttempt(
        db,
        pendingInput({ id: "past", stagePath: "stage-past", expiresAt: NOW })
      );
      await insertPendingAttempt(
        db,
        pendingInput({
          id: "future",
          userId: OTHER_USER,
          stagePath: "stage-future",
          expiresAt: new Date("2999-01-01T00:00:00.000Z")
        })
      );

      const expired = await expireAttempts(db, LATER);
      expect(expired).toEqual([{ id: "past", userId: DEFAULT_USER_ID, stagePath: "stage-past" }]);

      expect((await getAttempt(db, DEFAULT_USER_ID, "past"))?.state).toBe("expired");
      expect((await getAttempt(db, OTHER_USER, "future"))?.state).toBe("pending");
    });

    it("does not re-expire an already-terminal attempt", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1", expiresAt: NOW }));
      await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER);

      expect(await expireAttempts(db, LATER)).toEqual([]);
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.state).toBe("cancelled");
    });
  });

  describe("stage cleanup", () => {
    async function finalizing(id = "a1", stagePath: string | null = "stage-a1"): Promise<void> {
      await insertPendingAttempt(db, pendingInput({ id, stagePath }));
      await beginFinalizeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id,
        expectedRevision: 0,
        now: LATER
      });
    }

    it("transfers a stage during finalizing, fenced by owner and revision", async () => {
      await finalizing();

      // Finalizing sits at revision 1; the transfer applies at that revision and bumps it.
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 1,
          now: LATER
        })
      ).toEqual({ stagePath: "stage-a1", revision: 2 });

      const record = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(record?.stagePath).toBeNull();
      // Still finalizing at the bumped revision, so the caller completes at revision 2.
      expect(record?.state).toBe("finalizing");
      expect(record?.revision).toBe(2);
      const completed = await completeAttempt(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 2,
        now: LATER
      });
      expect(completed?.state).toBe("completed");
    });

    it("refuses to transfer a stage for a forged owner or a stale revision", async () => {
      await finalizing();

      // Forged owner.
      expect(
        await detachStagePath(db, { userId: OTHER_USER, id: "a1", expectedRevision: 1, now: LATER })
      ).toBeNull();
      // Stale revision (the begin-finalize already moved it to revision 1).
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 0,
          now: LATER
        })
      ).toBeNull();
      // Neither miss touched the stage.
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.stagePath).toBe("stage-a1");
    });

    it("refuses to transfer outside finalizing (pending or terminal) or when no stage is bound", async () => {
      // Pending: the decision slot was never claimed.
      await insertPendingAttempt(db, pendingInput({ id: "pend", stagePath: "stage-pend" }));
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "pend",
          expectedRevision: 0,
          now: LATER
        })
      ).toBeNull();
      expect((await getAttempt(db, DEFAULT_USER_ID, "pend"))?.stagePath).toBe("stage-pend");

      // Terminal: a cancelled attempt has already resolved.
      await cancelAttempt(db, DEFAULT_USER_ID, "pend", LATER);
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "pend",
          expectedRevision: 1,
          now: LATER
        })
      ).toBeNull();

      // Finalizing but owning no stage: nothing to transfer.
      await finalizing("nostage", null);
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "nostage",
          expectedRevision: 1,
          now: LATER
        })
      ).toBeNull();
    });

    it("returns null on a replayed transfer after the first detach (never re-transfers the same bytes)", async () => {
      await finalizing();

      const first = await detachStagePath(db, {
        userId: DEFAULT_USER_ID,
        id: "a1",
        expectedRevision: 1,
        now: LATER
      });
      expect(first).toEqual({ stagePath: "stage-a1", revision: 2 });

      // A replayed/concurrent transfer still holding revision 1 must not hand back the same bytes: the
      // fenced compare-and-set no longer matches (revision bumped, stage nulled), so it returns null
      // instead of the stale path a naive read-then-write would have surfaced.
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 1,
          now: LATER
        })
      ).toBeNull();
      // And a transfer at the bumped revision finds no stage bound (already detached), so it too misses.
      expect(
        await detachStagePath(db, {
          userId: DEFAULT_USER_ID,
          id: "a1",
          expectedRevision: 2,
          now: LATER
        })
      ).toBeNull();
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.revision).toBe(2);
    });

    it("clears a terminal attempt's stage for its owner after removal is confirmed", async () => {
      await insertPendingAttempt(db, pendingInput({ id: "a1", stagePath: "stage-a1" }));
      await cancelAttempt(db, DEFAULT_USER_ID, "a1", LATER);

      expect(await clearStagePath(db, { userId: DEFAULT_USER_ID, id: "a1", now: LATER })).toEqual({
        cleared: true
      });
      const row = await db
        .select()
        .from(workCreationAttempts)
        .where(eq(workCreationAttempts.id, "a1"));
      expect(row[0]?.stagePath).toBeNull();
    });

    it("refuses to clear a forged owner's stage or a still-active attempt", async () => {
      // Forged owner on a terminal attempt.
      await insertPendingAttempt(db, pendingInput({ id: "term", stagePath: "stage-term" }));
      await cancelAttempt(db, DEFAULT_USER_ID, "term", LATER);
      expect(await clearStagePath(db, { userId: OTHER_USER, id: "term", now: LATER })).toEqual({
        cleared: false
      });
      expect((await getAttempt(db, DEFAULT_USER_ID, "term"))?.stagePath).toBe("stage-term");

      // Still-active pending attempt: its bytes are not leftover cleanup.
      await insertPendingAttempt(
        db,
        pendingInput({ id: "pend", userId: OTHER_USER, stagePath: "stage-pend" })
      );
      expect(await clearStagePath(db, { userId: OTHER_USER, id: "pend", now: LATER })).toEqual({
        cleared: false
      });
      expect((await getAttempt(db, OTHER_USER, "pend"))?.stagePath).toBe("stage-pend");

      // Still-active finalizing attempt is likewise refused.
      await beginFinalizeAttempt(db, {
        userId: OTHER_USER,
        id: "pend",
        expectedRevision: 0,
        now: LATER
      });
      expect(await clearStagePath(db, { userId: OTHER_USER, id: "pend", now: LATER })).toEqual({
        cleared: false
      });
      expect((await getAttempt(db, OTHER_USER, "pend"))?.stagePath).toBe("stage-pend");
    });
  });
});
