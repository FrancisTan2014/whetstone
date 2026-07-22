import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PAGE_COUNT,
  MAX_STAGED_BYTES,
  RANGE_CONVERSION_SCHEMA_VERSION,
  type RangeConversion
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { pdfImportAttempts } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import {
  createFakeDoclingRunner,
  type DoclingRunner,
  type ProbeOutcome
} from "../../files/pdfStructuredAdapter.js";
import { malformedFailure } from "../../files/pdfStructuredErrors.js";
import {
  createPdfImportActiveRuns,
  processNextPdfImport,
  type PdfImportRunnerDependencies
} from "./pdfImportRunner.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
  getAttempt,
  getCommittedRangeIndices,
  insertQueuedAttempt,
  markCancelled,
  recoverInterruptedAttempts,
  retryInterrupted,
  setProbeResult
} from "./pdfImportStore.js";

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

const rawValid = JSON.stringify(payloadForPages(1, 50));
const rawUnsupported = JSON.stringify({
  ...payloadForPages(1, 1),
  doclingSchema: { name: "docling-core", version: "9.9.9" }
});

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

describe("processNextPdfImport", () => {
  let db: DbClient;
  let rootDir: string;
  let stageStore: PdfImportStageStore;

  beforeEach(async () => {
    db = await buildDb();
    rootDir = await mkdtemp(join(tmpdir(), "pdf-import-runner-"));
    stageStore = createPdfImportStageStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  async function seedStaged(id: string, bytes = new Uint8Array([1, 2, 3])): Promise<void> {
    const { stagePath } = await stageStore.createStage(id, bytes);
    await insertQueuedAttempt(db, {
      id,
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath,
      now: new Date()
    });
  }

  function buildDeps(
    overrides: Partial<PdfImportRunnerDependencies> = {}
  ): PdfImportRunnerDependencies {
    let token = 0;
    return {
      activeRuns: overrides.activeRuns ?? createPdfImportActiveRuns(),
      createRunToken: overrides.createRunToken ?? (() => `rt-${(token += 1)}`),
      db,
      logCleanupFailure: overrides.logCleanupFailure ?? (() => undefined),
      now: overrides.now ?? (() => new Date()),
      pageRangeSize: overrides.pageRangeSize,
      runner:
        overrides.runner ??
        createFakeDoclingRunner({
          probe: { status: "ok", pageCount: 1 },
          rangePayloads: [rawValid]
        }),
      stageStore: overrides.stageStore ?? stageStore
    };
  }

  it("is idle when nothing is queued", async () => {
    expect(await processNextPdfImport(buildDeps())).toEqual({ status: "idle" });
  });

  it("converts a staged attempt range by range and removes its stage", async () => {
    await seedStaged("a1");
    const handlePath = stageStore.openStage("a1").path;
    const deps = buildDeps({
      runner: createFakeDoclingRunner({
        probe: { status: "ok", pageCount: 5 },
        rangePayloads: [rawValid]
      }),
      pageRangeSize: 2
    });

    expect(await processNextPdfImport(deps)).toEqual({ status: "converted", attemptId: "a1" });

    const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
    expect(attempt).toMatchObject({ state: "converted", completedPages: 5, stagePath: null });
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([
      0, 1, 2
    ]);
    await expect(stat(handlePath)).rejects.toThrow();
  });

  it("resumes after the last committed range without re-probing", async () => {
    await seedStaged("a1");
    const runToken = "prior";
    await claimNextQueued(db, {
      runToken,
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      now: new Date()
    });
    await setProbeResult(db, {
      id: "a1",
      runToken,
      totalPages: 5,
      totalRanges: 3,
      now: new Date()
    });
    await commitRange(db, {
      attemptId: "a1",
      runToken,
      rangeIndex: 0,
      startPage: 1,
      endPage: 2,
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      payload: payloadForPages(1, 2),
      now: new Date()
    });
    await recoverInterruptedAttempts(db, new Date());
    await retryInterrupted(db, DEFAULT_USER_ID, "a1", new Date());

    // A probe that would fail if called proves the resumed run reuses the persisted plan.
    const resumeRunner: DoclingRunner = {
      probe: () => Promise.resolve({ status: "tool_missing" }),
      convertRange: () => Promise.resolve({ status: "ok", raw: rawValid })
    };
    const result = await processNextPdfImport(
      buildDeps({ runner: resumeRunner, pageRangeSize: 2 })
    );
    expect(result.status).toBe("converted");
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([
      0, 1, 2
    ]);
  });

  describe("probe failures free the stage and fail the attempt", () => {
    const cases: ReadonlyArray<readonly [string, ProbeOutcome, string]> = [
      ["tool missing", { status: "tool_missing" }, "tool_missing"],
      ["password required", { status: "password_required" }, "password_required"],
      ["malformed source", { status: "malformed", detail: "bad header" }, "malformed"],
      ["too many pages", { status: "ok", pageCount: MAX_PAGE_COUNT + 1 }, "too_many_pages"]
    ];

    for (const [name, probe, kind] of cases) {
      it(name, async () => {
        await seedStaged("a1");
        const handlePath = stageStore.openStage("a1").path;
        const result = await processNextPdfImport(
          buildDeps({ runner: createFakeDoclingRunner({ probe }) })
        );
        expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
        const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
        expect(attempt).toMatchObject({ state: "failed", stagePath: null });
        expect(attempt?.failure?.kind).toBe(kind);
        await expect(stat(handlePath)).rejects.toThrow();
      });
    }
  });

  it("fails on a malformed range payload", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: { status: "ok", pageCount: 1 },
          rangePayloads: ["{not json"]
        })
      })
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails on an unsupported converter schema", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: { status: "ok", pageCount: 1 },
          rangePayloads: [rawUnsupported]
        })
      })
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("unsupported_schema");
  });

  it("fails on a non-cancelled range run failure", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: { status: "ok", pageCount: 1 },
          failRangeWith: malformedFailure("boom")
        })
      })
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("stops (fenced) when a range run reports cancellation", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: { status: "ok", pageCount: 1 },
          failRangeWith: { kind: "cancelled", what: "cancelled", remedy: "retry" }
        })
      })
    );
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
  });

  it("stops (fenced) when the signal is aborted between ranges", async () => {
    await seedStaged("a1");
    const activeRuns = createPdfImportActiveRuns();
    let captured: AbortController | undefined;
    const wrapped = {
      register: (id: string, tok: string, controller: AbortController) => {
        captured = controller;
        activeRuns.register(id, tok, controller);
      },
      abort: activeRuns.abort,
      clear: activeRuns.clear
    };
    let calls = 0;
    const abortingRunner: DoclingRunner = {
      probe: () => Promise.resolve({ status: "ok", pageCount: 2 }),
      convertRange: () => {
        calls += 1;
        if (calls === 1) {
          captured?.abort();
        }
        return Promise.resolve({ status: "ok", raw: rawValid });
      }
    };
    const result = await processNextPdfImport(
      buildDeps({ runner: abortingRunner, activeRuns: wrapped, pageRangeSize: 1 })
    );
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
    // The first range committed before the abort; the run stopped without failing the attempt.
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([0]);
  });

  it("fences the probe write when a cancel lands mid-probe", async () => {
    await seedStaged("a1");
    const cancellingRunner: DoclingRunner = {
      probe: async () => {
        await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
        return { status: "ok", pageCount: 1 };
      },
      convertRange: () => Promise.resolve({ status: "ok", raw: rawValid })
    };
    const result = await processNextPdfImport(buildDeps({ runner: cancellingRunner }));
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
  });

  it("fences a range commit when a cancel lands mid-range", async () => {
    await seedStaged("a1");
    const cancellingRunner: DoclingRunner = {
      probe: () => Promise.resolve({ status: "ok", pageCount: 1 }),
      convertRange: async () => {
        await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
        return { status: "ok", raw: rawValid };
      }
    };
    const result = await processNextPdfImport(buildDeps({ runner: cancellingRunner }));
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([]);
  });

  it("fences the failure write when a cancel lands with a range failure", async () => {
    await seedStaged("a1");
    const cancellingRunner: DoclingRunner = {
      probe: () => Promise.resolve({ status: "ok", pageCount: 1 }),
      convertRange: async () => {
        await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
        return { status: "failure", failure: malformedFailure("boom") };
      }
    };
    const result = await processNextPdfImport(buildDeps({ runner: cancellingRunner }));
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
  });

  it("fails a claim with no bound stage", async () => {
    await seedStaged("a1");
    await db
      .update(pdfImportAttempts)
      .set({ stagePath: null })
      .where(eq(pdfImportAttempts.id, "a1"));
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails when the stage handle cannot be opened", async () => {
    // A stage path that is not a safe server-issued id makes openStage throw.
    await insertQueuedAttempt(db, {
      id: "a1",
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath: "bad/id",
      now: new Date()
    });
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails when the staged bytes cannot be read", async () => {
    // A valid stage id whose file was never written: openStage succeeds, stat fails.
    await insertQueuedAttempt(db, {
      id: "a1",
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath: "a1",
      now: new Date()
    });
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails an oversized staged file before spawning a child", async () => {
    await seedStaged("a1");
    await truncate(stageStore.openStage("a1").path, MAX_STAGED_BYTES + 1);
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("too_large");
  });

  it("retains the stage (bound, retryable) when cleanup fails after a successful conversion", async () => {
    await seedStaged("a1");
    const handlePath = stageStore.openStage("a1").path;
    const logCleanupFailure = vi.fn();
    const failingStore: PdfImportStageStore = {
      createStage: stageStore.createStage,
      openStage: stageStore.openStage,
      // A non-Error rejection also exercises the String(cause) fallback in the cleanup log.
      removeStage: () => Promise.reject("stage locked")
    };
    const result = await processNextPdfImport(
      buildDeps({ stageStore: failingStore, logCleanupFailure })
    );
    expect(result).toEqual({ status: "converted", attemptId: "a1" });
    expect(logCleanupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "a1", reason: "stage locked" })
    );
    // A failed removal must not forget the stage: the binding is retained and the bytes still exist, so
    // the terminal attempt stays bound and its cleanup can be retried.
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.stagePath).toBe("a1");
    await expect(stat(handlePath)).resolves.toBeDefined();
  });
});

describe("createPdfImportActiveRuns", () => {
  it("aborts the registered controller and ignores an unknown id", () => {
    const runs = createPdfImportActiveRuns();
    const controller = new AbortController();
    runs.register("a1", "t1", controller);
    runs.abort("missing");
    expect(controller.signal.aborted).toBe(false);
    runs.abort("a1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("clears only when the run token matches", () => {
    const runs = createPdfImportActiveRuns();
    const first = new AbortController();
    runs.register("a1", "t1", first);
    // A stale clear (wrong token) must not drop the live controller.
    runs.clear("a1", "other");
    runs.abort("a1");
    expect(first.signal.aborted).toBe(true);
    // The matching clear removes it, so a later abort is a no-op.
    runs.clear("a1", "t1");
    expect(() => runs.abort("a1")).not.toThrow();
  });
});
