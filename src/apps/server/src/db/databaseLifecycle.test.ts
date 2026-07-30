import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabaseLease } from "./databaseLease.js";
import { openManagedDatabase } from "./databaseLifecycle.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "whetstone-lifecycle-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function fakePglite(close: () => Promise<void> = async () => {}): { close: () => Promise<void> } {
  return { close };
}

describe("openManagedDatabase", () => {
  it("opens an in-memory database with no lease when the directory is undefined", async () => {
    const pglite = fakePglite();
    const openPglite = vi.fn(async () => pglite);
    const acquireLease = vi.fn(async (): Promise<DatabaseLease> => ({ release: async () => {} }));

    const managed = await openManagedDatabase({
      databaseDir: undefined,
      openPglite: openPglite as never,
      acquireLease,
      createDb: () => ({}) as never
    });

    expect(openPglite).toHaveBeenCalledWith(undefined);
    expect(acquireLease).not.toHaveBeenCalled();
    expect(managed.databaseDir).toBeUndefined();
  });

  it("treats a blank directory as in-memory and leaves the lease untouched", async () => {
    const acquireLease = vi.fn(async (): Promise<DatabaseLease> => ({ release: async () => {} }));

    const managed = await openManagedDatabase({
      databaseDir: "   ",
      openPglite: (async () => fakePglite()) as never,
      acquireLease,
      createDb: () => ({}) as never
    });

    expect(acquireLease).not.toHaveBeenCalled();
    expect(managed.databaseDir).toBeUndefined();
  });

  it("closes an in-memory database without touching a lease", async () => {
    const events: string[] = [];
    const pglite = fakePglite(async () => {
      events.push("pglite.close");
    });
    const acquireLease = vi.fn(async (): Promise<DatabaseLease> => ({ release: async () => {} }));

    const managed = await openManagedDatabase({
      databaseDir: undefined,
      openPglite: (async () => pglite) as never,
      acquireLease,
      createDb: () => ({}) as never
    });

    await managed.close();
    await managed.close();

    expect(events).toEqual(["pglite.close"]);
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("acquires the lease before constructing PGlite for a persistent directory", async () => {
    const order: string[] = [];
    const release = vi.fn(async () => {
      order.push("release");
    });
    const acquireLease = vi.fn(async (dir: string): Promise<DatabaseLease> => {
      order.push(`lease:${dir}`);
      return { release };
    });
    const openPglite = vi.fn(async (dir: string | undefined) => {
      order.push(`pglite:${dir}`);
      return fakePglite();
    });

    const managed = await openManagedDatabase({
      databaseDir: "/configured/db",
      canonicalizeDir: () => "/canonical/db",
      openPglite: openPglite as never,
      acquireLease,
      createDb: () => ({}) as never
    });

    expect(order).toEqual(["lease:/canonical/db", "pglite:/canonical/db"]);
    expect(managed.databaseDir).toBe("/canonical/db");
  });

  it("closes PGlite then releases the lease, exactly once across repeated close calls", async () => {
    const events: string[] = [];
    const pglite = fakePglite(async () => {
      events.push("pglite.close");
    });
    const release = vi.fn(async () => {
      events.push("lease.release");
    });

    const managed = await openManagedDatabase({
      databaseDir: "/configured/db",
      canonicalizeDir: () => "/canonical/db",
      openPglite: (async () => pglite) as never,
      acquireLease: async () => ({ release }),
      createDb: () => ({}) as never
    });

    await managed.close();
    await managed.close();

    expect(events).toEqual(["pglite.close", "lease.release"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease and rethrows when PGlite construction fails on startup", async () => {
    const failure = new Error("could not locate a valid checkpoint record");
    const release = vi.fn(async () => {});

    await expect(
      openManagedDatabase({
        databaseDir: "/configured/db",
        canonicalizeDir: () => "/canonical/db",
        openPglite: async () => {
          throw failure;
        },
        acquireLease: async () => ({ release }),
        createDb: () => ({}) as never
      })
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease held and stays fail-loud when close fails, never displacing a live owner", async () => {
    const closeFailure = new Error("checkpoint failed");
    const release = vi.fn(async () => {});
    let closeCalls = 0;

    const managed = await openManagedDatabase({
      databaseDir: "/configured/db",
      canonicalizeDir: () => "/canonical/db",
      openPglite: (async () =>
        fakePglite(async () => {
          closeCalls += 1;
          throw closeFailure;
        })) as never,
      acquireLease: async () => ({ release }),
      createDb: () => ({}) as never
    });

    // A failed PGlite close must NOT release the lease: the runtime has not proven it closed cleanly,
    // so the directory stays owned and the stale-lock path — not an immediate handoff — reclaims a
    // terminated owner.
    await expect(managed.close()).rejects.toBe(closeFailure);
    expect(release).not.toHaveBeenCalled();

    // Retrying stays fail-loud and still never hands the directory to another owner.
    await expect(managed.close()).rejects.toBe(closeFailure);
    expect(release).not.toHaveBeenCalled();
    expect(closeCalls).toBe(2);
  });

  it("canonicalizes a real directory and builds the default Drizzle client when not overridden", async () => {
    const parent = scratch();
    const configuredDir = join(parent, "nested", "db");
    let leasedDir: string | undefined;

    const managed = await openManagedDatabase({
      databaseDir: configuredDir,
      openPglite: (async () => fakePglite()) as never,
      acquireLease: async (dir) => {
        leasedDir = dir;
        return { release: async () => {} };
      }
    });

    // The default canonicalizer created the directory and resolved it to its realpath.
    expect(statSync(configuredDir).isDirectory()).toBe(true);
    expect(managed.databaseDir).toBe(realpathSync(configuredDir));
    expect(leasedDir).toBe(realpathSync(configuredDir));
    // The default createDb produced a Drizzle client instance.
    expect(managed.db).toBeDefined();
  });
});
