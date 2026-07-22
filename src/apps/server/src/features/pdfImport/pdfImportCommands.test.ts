import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { pdfImportAttempts } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import {
  cancelPdfImport,
  retryPdfImport,
  retryPdfImportCleanup,
  startPdfImport,
  type PdfImportCommandDependencies
} from "./pdfImportCommands.js";
import type { PdfImportActiveRuns } from "./pdfImportRunner.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  getAttempt,
  insertQueuedAttempt,
  recoverInterruptedAttempts
} from "./pdfImportStore.js";

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

function spyActiveRuns(): PdfImportActiveRuns {
  return { register: vi.fn(), abort: vi.fn(), clear: vi.fn() };
}

describe("pdfImport commands", () => {
  let db: DbClient;
  let rootDir: string;
  let stageStore: PdfImportStageStore;

  beforeEach(async () => {
    db = await buildDb();
    rootDir = await mkdtemp(join(tmpdir(), "pdf-import-commands-"));
    stageStore = createPdfImportStageStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  function buildDeps(
    overrides: Partial<PdfImportCommandDependencies> = {}
  ): PdfImportCommandDependencies {
    let id = 0;
    return {
      activeRuns: overrides.activeRuns ?? spyActiveRuns(),
      createAttemptId: overrides.createAttemptId ?? (() => `att-${(id += 1)}`),
      db,
      logCleanupFailure: overrides.logCleanupFailure ?? vi.fn(),
      now: overrides.now ?? (() => new Date()),
      stageStore: overrides.stageStore ?? stageStore
    };
  }

  async function seedStaged(id: string): Promise<void> {
    const { stagePath } = await stageStore.createStage(id, new Uint8Array([1, 2, 3]));
    await insertQueuedAttempt(db, {
      id,
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath,
      now: new Date()
    });
  }

  describe("startPdfImport", () => {
    it("stages the bytes and queues a new attempt", async () => {
      const deps = buildDeps({ createAttemptId: () => "att-1" });
      const started = await startPdfImport(deps, {
        userId: DEFAULT_USER_ID,
        bytes: new Uint8Array([9, 9])
      });

      expect(started.attemptId).toBe("att-1");
      expect(started.status).toMatchObject({
        attemptId: "att-1",
        state: "queued",
        stage: { bound: true }
      });
      const attempt = await getAttempt(db, DEFAULT_USER_ID, "att-1");
      expect(attempt?.state).toBe("queued");
      await expect(stat(stageStore.openStage("att-1").path)).resolves.toBeDefined();
    });

    it("preserves an existing attempt's stage on an id collision", async () => {
      // seedStaged writes bytes [1,2,3] under id "dup" and inserts its queued row.
      await seedStaged("dup");
      const existingStagePath = stageStore.openStage("dup").path;
      const logCleanupFailure = vi.fn();
      const deps = buildDeps({ createAttemptId: () => "dup", logCleanupFailure });

      // A start that reuses the live id must fail on exclusive stage creation WITHOUT overwriting the
      // existing attempt's staged bytes or disturbing its row.
      await expect(
        startPdfImport(deps, { userId: DEFAULT_USER_ID, bytes: new Uint8Array([9, 9, 9]) })
      ).rejects.toThrow();
      expect(new Uint8Array(await readFile(existingStagePath))).toEqual(new Uint8Array([1, 2, 3]));
      const existing = await getAttempt(db, DEFAULT_USER_ID, "dup");
      expect(existing).toMatchObject({ state: "queued", stagePath: "dup" });
      expect(logCleanupFailure).not.toHaveBeenCalled();
    });

    it("surfaces a cleanup failure when rolling back a created stage fails", async () => {
      // Pre-existing row owns id "dup" with no stage dir, so createStage succeeds and the insert fails;
      // a removeStage that rejects during rollback must be surfaced, not swallowed.
      await insertQueuedAttempt(db, {
        id: "dup",
        userId: DEFAULT_USER_ID,
        sourceHash: "a".repeat(64),
        stagePath: "dup",
        now: new Date()
      });
      const logCleanupFailure = vi.fn();
      const failingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage: () => Promise.reject("busy")
      };
      const deps = buildDeps({
        createAttemptId: () => "dup",
        logCleanupFailure,
        stageStore: failingStore
      });

      await expect(
        startPdfImport(deps, { userId: DEFAULT_USER_ID, bytes: new Uint8Array([1]) })
      ).rejects.toThrow();
      expect(logCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "dup", reason: "busy" })
      );
    });

    it("rolls back only the stage this start created when the bind insert fails", async () => {
      // A pre-existing row owns id "dup" but has NO stage directory on disk, so this start's exclusive
      // stage creation succeeds (fresh) and the bind insert then fails on the primary key.
      await insertQueuedAttempt(db, {
        id: "dup",
        userId: DEFAULT_USER_ID,
        sourceHash: "a".repeat(64),
        stagePath: "dup",
        now: new Date()
      });
      const deps = buildDeps({ createAttemptId: () => "dup" });

      await expect(
        startPdfImport(deps, { userId: DEFAULT_USER_ID, bytes: new Uint8Array([1]) })
      ).rejects.toThrow();
      // The stage this start created was rolled back, and the pre-existing row is untouched.
      await expect(stat(stageStore.openStage("dup").path)).rejects.toThrow();
      expect(await getAttempt(db, DEFAULT_USER_ID, "dup")).toMatchObject({ state: "queued" });
    });
  });

  describe("cancelPdfImport", () => {
    it("cancels a queued attempt and frees its stage without aborting a child", async () => {
      await seedStaged("a1");
      const activeRuns = spyActiveRuns();
      const result = await cancelPdfImport(buildDeps({ activeRuns }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(true);
      expect(result.status?.state).toBe("cancelled");
      expect(activeRuns.abort).not.toHaveBeenCalled();
      await expect(stat(stageStore.openStage("a1").path)).rejects.toThrow();
    });

    it("aborts the owned child when cancelling a running attempt", async () => {
      await seedStaged("a1");
      await claimNextQueued(db, {
        runToken: "rt",
        fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
        now: new Date()
      });
      const activeRuns = spyActiveRuns();
      const result = await cancelPdfImport(buildDeps({ activeRuns }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(true);
      expect(activeRuns.abort).toHaveBeenCalledWith("a1");
    });

    it("is a no-op on an already-terminal attempt", async () => {
      await seedStaged("a1");
      await cancelPdfImport(buildDeps(), { userId: DEFAULT_USER_ID, attemptId: "a1" });
      const activeRuns = spyActiveRuns();
      const result = await cancelPdfImport(buildDeps({ activeRuns }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(false);
      expect(result.status?.state).toBe("cancelled");
      expect(activeRuns.abort).not.toHaveBeenCalled();
    });

    it("keeps the stage bound and retryable when cleanup fails", async () => {
      await seedStaged("a1");
      const logCleanupFailure = vi.fn();
      const failingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage: () => Promise.reject(new Error("locked"))
      };
      const result = await cancelPdfImport(
        buildDeps({ stageStore: failingStore, logCleanupFailure }),
        {
          userId: DEFAULT_USER_ID,
          attemptId: "a1"
        }
      );

      expect(result.applied).toBe(true);
      expect(logCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "a1", reason: "locked" })
      );
      // A failed removal must NOT forget the stage: the binding is retained (status stays bound) and the
      // bytes still exist, so the cleanup can be retried later instead of the bytes lingering untracked.
      expect(result.status?.stage.bound).toBe(true);
      const stillBound = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(stillBound?.stagePath).toBe("a1");
      await expect(stat(stageStore.openStage("a1").path)).resolves.toBeDefined();
    });

    it("surfaces a stage cleanup failure via the logger", async () => {
      await seedStaged("a1");
      const logCleanupFailure = vi.fn();
      const failingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage: () => Promise.reject(new Error("locked"))
      };
      const result = await cancelPdfImport(
        buildDeps({ stageStore: failingStore, logCleanupFailure }),
        {
          userId: DEFAULT_USER_ID,
          attemptId: "a1"
        }
      );

      expect(result.applied).toBe(true);
      expect(logCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "a1", reason: "locked" })
      );
    });

    it("stringifies a non-Error cleanup rejection for the logger", async () => {
      await seedStaged("a1");
      const logCleanupFailure = vi.fn();
      const failingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage: () => Promise.reject("stage busy")
      };
      const result = await cancelPdfImport(
        buildDeps({ stageStore: failingStore, logCleanupFailure }),
        {
          userId: DEFAULT_USER_ID,
          attemptId: "a1"
        }
      );

      expect(result.applied).toBe(true);
      expect(logCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "a1", reason: "stage busy" })
      );
    });

    it("cancels a stage-less attempt without touching the stage store", async () => {
      await seedStaged("a1");
      await db
        .update(pdfImportAttempts)
        .set({ stagePath: null })
        .where(eq(pdfImportAttempts.id, "a1"));
      const removeStage = vi.fn(() => Promise.resolve());
      const noRemoveStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage
      };
      const result = await cancelPdfImport(buildDeps({ stageStore: noRemoveStore }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(true);
      expect(result.status?.state).toBe("cancelled");
      expect(removeStage).not.toHaveBeenCalled();
    });

    it("reports no status when cancelling an unknown attempt", async () => {
      const result = await cancelPdfImport(buildDeps(), {
        userId: DEFAULT_USER_ID,
        attemptId: "missing"
      });

      expect(result.applied).toBe(false);
      expect(result.status).toBeNull();
    });
  });

  describe("retryPdfImport", () => {
    it("re-queues an interrupted attempt", async () => {
      await seedStaged("a1");
      await claimNextQueued(db, {
        runToken: "rt",
        fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
        now: new Date()
      });
      await recoverInterruptedAttempts(db, new Date());
      const result = await retryPdfImport(buildDeps(), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(true);
      expect(result.status?.state).toBe("queued");
    });

    it("does not retry a non-interrupted attempt", async () => {
      await seedStaged("a1");
      const result = await retryPdfImport(buildDeps(), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(false);
      expect(result.status?.state).toBe("queued");
    });
  });

  describe("retryPdfImportCleanup", () => {
    // A store whose removeStage always rejects, to drive a cleanup failure that leaves the stage bound.
    function rejectingStore(reason: unknown): PdfImportStageStore {
      return {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage: () => Promise.reject(reason)
      };
    }

    // Cancel with a failing store so the attempt is terminal (`cancelled`) yet still bound: its earlier
    // cleanup failed and the staged bytes remain on disk. This is the state the reviewer flagged as stuck.
    async function cancelLeavingStageBound(id: string): Promise<void> {
      await seedStaged(id);
      const result = await cancelPdfImport(
        buildDeps({ stageStore: rejectingStore(new Error("locked")), logCleanupFailure: vi.fn() }),
        { userId: DEFAULT_USER_ID, attemptId: id }
      );
      expect(result.status?.state).toBe("cancelled");
      expect(result.status?.stage.bound).toBe(true);
    }

    it("removes the leftover stage and clears the binding on a second call after a failed cleanup", async () => {
      await cancelLeavingStageBound("a1");
      // The bytes are still on disk and the row is still bound after the failed cleanup.
      await expect(stat(stageStore.openStage("a1").path)).resolves.toBeDefined();

      // A retry with a working store removes the stage and clears the binding: cleanup is retryable.
      const result = await retryPdfImportCleanup(buildDeps(), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(true);
      expect(result.status?.state).toBe("cancelled");
      expect(result.status?.stage.bound).toBe(false);
      const cleared = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(cleared?.stagePath).toBeNull();
      await expect(stat(stageStore.openStage("a1").path)).rejects.toThrow();
    });

    it("keeps the stage bound and retryable when the cleanup retry itself fails again", async () => {
      await cancelLeavingStageBound("a1");
      const logCleanupFailure = vi.fn();
      const result = await retryPdfImportCleanup(
        buildDeps({ stageStore: rejectingStore("still locked"), logCleanupFailure }),
        { userId: DEFAULT_USER_ID, attemptId: "a1" }
      );

      expect(result.applied).toBe(false);
      expect(result.status?.stage.bound).toBe(true);
      expect(logCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "a1", reason: "still locked" })
      );
      await expect(stat(stageStore.openStage("a1").path)).resolves.toBeDefined();
    });

    it("does not remove the stage of a non-terminal attempt", async () => {
      await seedStaged("a1");
      const removeStage = vi.fn(() => Promise.resolve());
      const spyingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage
      };
      const result = await retryPdfImportCleanup(buildDeps({ stageStore: spyingStore }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(false);
      expect(result.status?.state).toBe("queued");
      expect(result.status?.stage.bound).toBe(true);
      expect(removeStage).not.toHaveBeenCalled();
      await expect(stat(stageStore.openStage("a1").path)).resolves.toBeDefined();
    });

    it("is a no-op for an already-unbound terminal attempt", async () => {
      await seedStaged("a1");
      await cancelPdfImport(buildDeps(), { userId: DEFAULT_USER_ID, attemptId: "a1" });
      const removeStage = vi.fn(() => Promise.resolve());
      const spyingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage
      };
      const result = await retryPdfImportCleanup(buildDeps({ stageStore: spyingStore }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(false);
      expect(result.status?.state).toBe("cancelled");
      expect(result.status?.stage.bound).toBe(false);
      expect(removeStage).not.toHaveBeenCalled();
    });

    it("reports no status when retrying cleanup for an unknown attempt", async () => {
      const result = await retryPdfImportCleanup(buildDeps(), {
        userId: DEFAULT_USER_ID,
        attemptId: "missing"
      });

      expect(result.applied).toBe(false);
      expect(result.status).toBeNull();
    });
  });
});
