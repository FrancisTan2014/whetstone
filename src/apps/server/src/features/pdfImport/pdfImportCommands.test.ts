import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import {
  cancelPdfImport,
  retryPdfImport,
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
      const started = await startPdfImport(deps, { userId: DEFAULT_USER_ID, bytes: new Uint8Array([9, 9]) });

      expect(started.attemptId).toBe("att-1");
      expect(started.status).toMatchObject({ attemptId: "att-1", state: "queued", stage: { bound: true } });
      const attempt = await getAttempt(db, DEFAULT_USER_ID, "att-1");
      expect(attempt?.state).toBe("queued");
      await expect(stat(stageStore.openStage("att-1").path)).resolves.toBeDefined();
    });

    it("rolls the stage back when binding the attempt fails", async () => {
      // A pre-existing row with the same id makes the bind insert fail on the primary key.
      await seedStaged("dup");
      const logCleanupFailure = vi.fn();
      const deps = buildDeps({ createAttemptId: () => "dup", logCleanupFailure });

      await expect(
        startPdfImport(deps, { userId: DEFAULT_USER_ID, bytes: new Uint8Array([1]) })
      ).rejects.toThrow();
      await expect(stat(stageStore.openStage("dup").path)).rejects.toThrow();
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

    it("surfaces a stage cleanup failure via the logger", async () => {
      await seedStaged("a1");
      const logCleanupFailure = vi.fn();
      const failingStore: PdfImportStageStore = {
        createStage: stageStore.createStage,
        openStage: stageStore.openStage,
        removeStage: () => Promise.reject(new Error("locked"))
      };
      const result = await cancelPdfImport(buildDeps({ stageStore: failingStore, logCleanupFailure }), {
        userId: DEFAULT_USER_ID,
        attemptId: "a1"
      });

      expect(result.applied).toBe(true);
      expect(logCleanupFailure).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "a1", reason: "locked" })
      );
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
      const result = await retryPdfImport(buildDeps(), { userId: DEFAULT_USER_ID, attemptId: "a1" });

      expect(result.applied).toBe(true);
      expect(result.status?.state).toBe("queued");
    });

    it("does not retry a non-interrupted attempt", async () => {
      await seedStaged("a1");
      const result = await retryPdfImport(buildDeps(), { userId: DEFAULT_USER_ID, attemptId: "a1" });

      expect(result.applied).toBe(false);
      expect(result.status?.state).toBe("queued");
    });
  });
});
