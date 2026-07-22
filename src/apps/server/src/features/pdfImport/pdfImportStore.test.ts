import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RANGE_CONVERSION_SCHEMA_VERSION, type RangeConversion } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { pdfImportAttempts } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  clearStagePath,
  commitRange,
  countCommittedRanges,
  getAttempt,
  getAttemptById,
  getCommittedRangeIndices,
  heartbeat,
  insertQueuedAttempt,
  markCancelled,
  markConverted,
  markFailed,
  recoverInterruptedAttempts,
  retryInterrupted,
  setProbeResult
} from "./pdfImportStore.js";

const OTHER_USER = "user-other";
const doclingSchema = { name: "docling-core", version: "1.10.0" } as const;

function payloadForPages(startPage: number, endPage: number): RangeConversion {
  const pages = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pages.push({ pageNumber: page, hasNativeText: true });
  }
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema,
    pages,
    body: [],
    furniture: []
  };
}

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

async function seedQueued(
  db: DbClient,
  id: string,
  overrides: Partial<{ userId: string; stagePath: string; now: Date }> = {}
): Promise<void> {
  await insertQueuedAttempt(db, {
    id,
    userId: overrides.userId ?? DEFAULT_USER_ID,
    sourceHash: "a".repeat(64),
    stagePath: overrides.stagePath ?? `stage-${id}`,
    now: overrides.now ?? new Date("2026-01-01T00:00:00.000Z")
  });
}

async function claim(db: DbClient, fingerprint = PDF_IMPORT_ADAPTER_FINGERPRINT) {
  const runToken = `token-${Math.random()}`;
  const claimed = await claimNextQueued(db, { runToken, fingerprint, now: new Date() });
  return { claimed, runToken };
}

describe("pdfImportStore", () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await buildDb();
  });

  afterEach(() => {
    // PGlite is in-memory per test; nothing to close explicitly for the drizzle client.
  });

  describe("insert / get", () => {
    it("inserts a queued attempt with defaults and reads it back by owner and by id", async () => {
      await seedQueued(db, "a1");
      const byOwner = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(byOwner).toMatchObject({
        id: "a1",
        state: "queued",
        completedPages: 0,
        runToken: null,
        adapterFingerprint: null,
        failure: null,
        totalPages: null,
        totalRanges: null,
        stagePath: "stage-a1"
      });
      const byId = await getAttemptById(db, "a1");
      expect(byId?.id).toBe("a1");
    });

    it("does not leak another user's attempt and returns null for a missing id", async () => {
      await seedQueued(db, "a1");
      expect(await getAttempt(db, OTHER_USER, "a1")).toBeNull();
      expect(await getAttempt(db, DEFAULT_USER_ID, "missing")).toBeNull();
      expect(await getAttemptById(db, "missing")).toBeNull();
    });
  });

  describe("claimNextQueued", () => {
    it("returns null when the queue is empty", async () => {
      const { claimed } = await claim(db);
      expect(claimed).toBeNull();
    });

    it("claims the oldest queued attempt and marks it running under the run token", async () => {
      await seedQueued(db, "old", { now: new Date("2026-01-01T00:00:00.000Z") });
      await seedQueued(db, "new", { now: new Date("2026-01-02T00:00:00.000Z") });
      const { claimed, runToken } = await claim(db);
      expect(claimed?.id).toBe("old");
      expect(claimed?.state).toBe("running");
      expect(claimed?.runToken).toBe(runToken);
      expect(claimed?.adapterFingerprint).toBe(PDF_IMPORT_ADAPTER_FINGERPRINT);
    });

    it("admits only one running attempt at a time", async () => {
      await seedQueued(db, "a1");
      await seedQueued(db, "a2");
      const first = await claim(db);
      expect(first.claimed?.id).toBe("a1");
      const second = await claim(db);
      expect(second.claimed).toBeNull();
    });

    it("does not overwrite the winner's run token or start a second attempt while one runs", async () => {
      await seedQueued(db, "a1");
      await seedQueued(db, "a2");
      const first = await claim(db);
      expect(first.claimed?.id).toBe("a1");
      expect(first.claimed?.state).toBe("running");

      // A second caller must not re-claim the running attempt (token overwrite) nor start a2.
      const second = await claim(db);
      expect(second.claimed).toBeNull();

      const a1 = await getAttemptById(db, "a1");
      expect(a1?.state).toBe("running");
      expect(a1?.runToken).toBe(first.runToken);
      const a2 = await getAttemptById(db, "a2");
      expect(a2?.state).toBe("queued");
      expect(a2?.runToken).toBeNull();
    });

    it("admits exactly one winner under concurrent claims and keeps its run token", async () => {
      await seedQueued(db, "a1");
      await seedQueued(db, "a2");

      const results = await Promise.all([
        claimNextQueued(db, {
          runToken: "token-A",
          fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
          now: new Date()
        }),
        claimNextQueued(db, {
          runToken: "token-B",
          fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
          now: new Date()
        })
      ]);

      const winners = results.filter((r): r is NonNullable<typeof r> => r !== null);
      expect(winners).toHaveLength(1);

      const running = await db
        .select()
        .from(pdfImportAttempts)
        .where(eq(pdfImportAttempts.state, "running"));
      expect(running).toHaveLength(1);
      // The single running row carries exactly the winner's token — no rival overwrote it.
      expect(running[0]?.id).toBe(winners[0]!.id);
      expect(running[0]?.runToken).toBe(winners[0]!.runToken);
    });

    it("drops stale-fingerprint ranges and recomputes progress on re-claim", async () => {
      await seedQueued(db, "a1");
      const first = await claim(db, "old-fingerprint@1");
      expect(first.claimed?.id).toBe("a1");
      await commitRange(db, {
        attemptId: "a1",
        runToken: first.runToken,
        rangeIndex: 0,
        startPage: 1,
        endPage: 10,
        fingerprint: "old-fingerprint@1",
        payload: payloadForPages(1, 10),
        now: new Date()
      });
      // Simulate a re-queue (as a retry would), then re-claim under the current build.
      await db
        .update(pdfImportAttempts)
        .set({ state: "queued", runToken: null })
        .where(eq(pdfImportAttempts.id, "a1"));

      const second = await claim(db, PDF_IMPORT_ADAPTER_FINGERPRINT);
      expect(second.claimed?.completedPages).toBe(0);
      expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([]);
      // The stale range was deleted, so no ranges remain at all.
      expect(await countCommittedRanges(db, "a1")).toBe(0);
    });
  });

  describe("fenced run-token writes", () => {
    it("applies probe/heartbeat/commit under the live token and fences a stale token", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);

      expect(
        await setProbeResult(db, {
          id: "a1",
          runToken,
          totalPages: 30,
          totalRanges: 3,
          now: new Date()
        })
      ).toBe(true);
      expect(
        await setProbeResult(db, {
          id: "a1",
          runToken: "stale",
          totalPages: 1,
          totalRanges: 1,
          now: new Date()
        })
      ).toBe(false);

      expect(await heartbeat(db, "a1", runToken, new Date())).toBe(true);
      expect(await heartbeat(db, "a1", "stale", new Date())).toBe(false);

      const probed = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(probed).toMatchObject({ totalPages: 30, totalRanges: 3 });
    });

    it("commits a range idempotently and recomputes completed pages", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);
      const input = {
        attemptId: "a1",
        runToken,
        rangeIndex: 0,
        startPage: 1,
        endPage: 10,
        fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
        payload: payloadForPages(1, 10),
        now: new Date()
      };
      expect(await commitRange(db, input)).toBe(true);
      // A duplicate commit is a no-op that still reports success; pages are not double counted.
      expect(await commitRange(db, input)).toBe(true);
      const after = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(after?.completedPages).toBe(10);
      expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([0]);
      expect(await countCommittedRanges(db, "a1")).toBe(1);
    });

    it("fences a commit from a stale token and one for an unknown attempt", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);
      const base = {
        rangeIndex: 0,
        startPage: 1,
        endPage: 5,
        fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
        payload: payloadForPages(1, 5),
        now: new Date()
      };
      expect(await commitRange(db, { ...base, attemptId: "a1", runToken: "stale" })).toBe(false);
      expect(await commitRange(db, { ...base, attemptId: "missing", runToken })).toBe(false);
      expect(await countCommittedRanges(db, "a1")).toBe(0);
    });
  });

  describe("terminal transitions", () => {
    it("marks converted (retaining the stage until cleanup) only under the live token", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);
      expect(await markConverted(db, "a1", "stale", new Date())).toBe(false);
      expect(await markConverted(db, "a1", runToken, new Date())).toBe(true);
      const done = await getAttempt(db, DEFAULT_USER_ID, "a1");
      // The stage binding is kept on the terminal row so a cleanup failure stays visible/retryable; it
      // is cleared only after the bytes are actually removed (via clearStagePath).
      expect(done).toMatchObject({
        state: "converted",
        runToken: null,
        stagePath: "stage-a1",
        heartbeatAt: null
      });
    });

    it("marks failed with a typed failure only under the live token", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);
      const failure = { kind: "malformed", message: "bad pdf.", remedy: "re-export." };
      expect(await markFailed(db, "a1", "stale", failure, new Date())).toBe(false);
      expect(await markFailed(db, "a1", runToken, failure, new Date())).toBe(true);
      const failed = await getAttempt(db, DEFAULT_USER_ID, "a1");
      // Stage retained until cleanup succeeds (see clearStagePath).
      expect(failed).toMatchObject({ state: "failed", failure, stagePath: "stage-a1" });
    });

    it("clears the stage binding only after cleanup, keeping it retryable on failure", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);
      await markConverted(db, "a1", runToken, new Date());
      // Until cleanup runs, the terminal row still owns its stage (status stays bound, retryable).
      expect((await getAttemptById(db, "a1"))?.stagePath).toBe("stage-a1");
      await clearStagePath(db, "a1", new Date());
      expect((await getAttemptById(db, "a1"))?.stagePath).toBeNull();
    });
  });

  describe("markCancelled", () => {
    it("cancels a queued attempt (no running child) and returns its stage", async () => {
      await seedQueued(db, "a1");
      const result = await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
      expect(result).toEqual({ cancelled: true, wasRunning: false, stagePath: "stage-a1" });
      const after = await getAttempt(db, DEFAULT_USER_ID, "a1");
      // Cancel keeps the stage binding so a failed removal stays retryable; the caller clears it after
      // the bytes are actually removed.
      expect(after).toMatchObject({ state: "cancelled", stagePath: "stage-a1" });
    });

    it("cancels a running attempt and flags that a child must be terminated", async () => {
      await seedQueued(db, "a1");
      await claim(db);
      const result = await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
      expect(result.cancelled).toBe(true);
      expect(result.wasRunning).toBe(true);
    });

    it("cancels an interrupted attempt", async () => {
      await seedQueued(db, "a1");
      await claim(db);
      await recoverInterruptedAttempts(db, new Date());
      const result = await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
      expect(result).toMatchObject({ cancelled: true, wasRunning: false });
    });

    it("refuses to cancel a terminal attempt or another user's attempt", async () => {
      await seedQueued(db, "a1");
      const { runToken } = await claim(db);
      await markConverted(db, "a1", runToken, new Date());
      expect((await markCancelled(db, DEFAULT_USER_ID, "a1", new Date())).cancelled).toBe(false);

      await seedQueued(db, "a2");
      expect((await markCancelled(db, OTHER_USER, "a2", new Date())).cancelled).toBe(false);
    });
  });

  describe("recovery and retry", () => {
    it("recovers abandoned running attempts to interrupted and leaves others untouched", async () => {
      await seedQueued(db, "running");
      await claim(db);
      await seedQueued(db, "queued");
      const recovered = await recoverInterruptedAttempts(db, new Date());
      expect(recovered).toBe(1);
      expect((await getAttempt(db, DEFAULT_USER_ID, "running"))?.state).toBe("interrupted");
      expect((await getAttempt(db, DEFAULT_USER_ID, "queued"))?.state).toBe("queued");
    });

    it("retries only an interrupted attempt and rejects other states or another user", async () => {
      await seedQueued(db, "a1");
      await claim(db);
      await recoverInterruptedAttempts(db, new Date());

      expect(await retryInterrupted(db, OTHER_USER, "a1", new Date())).toBe(false);
      expect(await retryInterrupted(db, DEFAULT_USER_ID, "a1", new Date())).toBe(true);
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.state).toBe("queued");
      // A now-queued (non-interrupted) attempt is not retryable.
      expect(await retryInterrupted(db, DEFAULT_USER_ID, "a1", new Date())).toBe(false);
      expect(await retryInterrupted(db, DEFAULT_USER_ID, "missing", new Date())).toBe(false);
    });
  });
});
