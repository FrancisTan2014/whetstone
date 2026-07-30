import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabaseLeaseAcquirer, DatabaseBusyError } from "./databaseLease.js";
import { openManagedDatabase } from "./databaseLifecycle.js";

// The real single-owner lease contract (#805) can only be proven with a SECOND operating-system
// process contending for the same `proper-lockfile` lock. These tests spawn a child worker that holds
// the real lease and assert: a live competitor is rejected before PGlite construction, a graceful owner
// hands the lease off, a forcibly-killed owner's directory is reclaimable once its heartbeat goes
// stale, and the lifecycle closes PGlite and releases the lock exactly once. Runs in the isolated lane
// (vitest.isolated.config.ts); it is a real cross-process/filesystem contract, not a coverage source.

const STALE_MS = 2_000; // proper-lockfile's minimum stale window.
const UPDATE_MS = 1_000;

const workerPath = fileURLToPath(new URL("./databaseLease.crossProcessWorker.ts", import.meta.url));
const serverRoot = fileURLToPath(new URL("../../", import.meta.url));

const scratchDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function scratchDatabaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "whetstone-lease-"));
  scratchDirs.push(dir);
  return realpathSync(dir);
}

type Worker = Readonly<{
  child: ChildProcessWithoutNullStreams;
  waitForLine: (needle: string) => Promise<void>;
  waitForExit: () => Promise<number | null>;
}>;

function spawnLeaseWorker(databaseDir: string): Worker {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, databaseDir, String(STALE_MS), String(UPDATE_MS)],
    { cwd: serverRoot, stdio: ["pipe", "pipe", "pipe"] }
  );
  children.push(child);

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return {
    child,
    waitForLine: (needle) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for "${needle}". stdout=${stdout} stderr=${stderr}`));
        }, 20_000);
        const check = (): void => {
          if (stdout.includes(needle)) {
            clearTimeout(timer);
            child.stdout.off("data", check);
            resolve();
          }
        };
        child.stdout.on("data", check);
        check();
      }),
    waitForExit: () =>
      new Promise<number | null>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.on("exit", (code) => resolve(code));
      })
  };
}

function realLeaseAcquirer() {
  return import("proper-lockfile").then((lockfile) =>
    createDatabaseLeaseAcquirer({
      lock: (file, options) => lockfile.lock(file, options),
      onCompromised: () => {},
      staleMs: STALE_MS,
      updateMs: UPDATE_MS
    })
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reclaim a stale lock, tolerating filesystem mtime granularity: retry across the stale boundary until
// the abandoned lock is reclaimed or the window is clearly exceeded.
async function acquireOnceStale(
  acquire: (dir: string) => Promise<{ release: () => Promise<void> }>,
  databaseDir: string
): Promise<{ release: () => Promise<void> }> {
  const deadline = Date.now() + STALE_MS * 4;
  for (;;) {
    try {
      return await acquire(databaseDir);
    } catch (error) {
      if (!(error instanceof DatabaseBusyError) || Date.now() > deadline) {
        throw error;
      }
      await delay(250);
    }
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  // Let the stale window elapse so a killed worker's lock never leaks into the next test's directory.
  await delay(STALE_MS + 250);
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("database lease cross-process contract", () => {
  it("rejects a second owner while the first process holds the lease", async () => {
    const databaseDir = scratchDatabaseDir();
    const worker = spawnLeaseWorker(databaseDir);
    await worker.waitForLine("ACQUIRED");

    const acquire = await realLeaseAcquirer();
    await expect(acquire(databaseDir)).rejects.toBeInstanceOf(DatabaseBusyError);
  }, 60_000);

  it("hands the lease off after a graceful owner closes and releases", async () => {
    const databaseDir = scratchDatabaseDir();
    const worker = spawnLeaseWorker(databaseDir);
    await worker.waitForLine("ACQUIRED");

    // Trigger the worker's graceful release over stdin (Windows cannot deliver a catchable SIGTERM).
    worker.child.stdin.write("RELEASE\n");
    await worker.waitForLine("RELEASED");
    expect(await worker.waitForExit()).toBe(0);

    const acquire = await realLeaseAcquirer();
    const lease = await acquire(databaseDir);
    await lease.release();
  }, 60_000);

  it("reclaims a forcibly terminated owner's directory only after its lease goes stale", async () => {
    const databaseDir = scratchDatabaseDir();
    const worker = spawnLeaseWorker(databaseDir);
    await worker.waitForLine("ACQUIRED");

    worker.child.kill("SIGKILL");
    await worker.waitForExit();

    const acquire = await realLeaseAcquirer();
    // The abandoned lock is still fresh, so a live owner is not displaced merely because it is gone.
    await expect(acquire(databaseDir)).rejects.toBeInstanceOf(DatabaseBusyError);

    // Once the heartbeat is stale, the directory is reclaimable without touching the database itself.
    // Poll across the stale boundary so filesystem mtime granularity never flakes the assertion.
    const lease = await acquireOnceStale(acquire, databaseDir);
    await lease.release();
  }, 60_000);

  it("closes PGlite and releases the real lease exactly once across repeated shutdown", async () => {
    const databaseDir = scratchDatabaseDir();
    const acquire = await realLeaseAcquirer();
    const close = vi.fn(async () => {});

    const managed = await openManagedDatabase({
      databaseDir,
      canonicalizeDir: (dir) => dir,
      openPglite: async () => ({ close }) as never,
      acquireLease: acquire
    });

    await managed.close();
    await managed.close();
    expect(close).toHaveBeenCalledTimes(1);

    // The lock was released, so a fresh acquisition succeeds immediately (no stale wait needed).
    const lease = await acquire(databaseDir);
    await lease.release();
  }, 60_000);
});
