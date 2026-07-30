import { describe, expect, it, vi } from "vitest";

import {
  createDatabaseLeaseAcquirer,
  DatabaseBusyError,
  DATABASE_LEASE_STALE_MS,
  DATABASE_LEASE_UPDATE_MS,
  type LeaseLockOptions,
  type LockPrimitive
} from "./databaseLease.js";

describe("createDatabaseLeaseAcquirer", () => {
  it("acquires a lease with the production timings and a canonical, non-realpath lock path", async () => {
    let seenFile: string | undefined;
    let seenOptions: LeaseLockOptions | undefined;
    const release = vi.fn(async () => {});
    const lock: LockPrimitive = async (file, options) => {
      seenFile = file;
      seenOptions = options;
      return release;
    };

    const acquire = createDatabaseLeaseAcquirer({ lock, onCompromised: () => {} });
    const lease = await acquire("/canonical/db");

    expect(seenFile).toBe("/canonical/db");
    expect(seenOptions).toMatchObject({
      stale: DATABASE_LEASE_STALE_MS,
      update: DATABASE_LEASE_UPDATE_MS,
      realpath: false,
      retries: 0
    });

    await lease.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("forwards custom timings and retry policy to the lock primitive", async () => {
    let seenOptions: LeaseLockOptions | undefined;
    const lock: LockPrimitive = async (_file, options) => {
      seenOptions = options;
      return async () => {};
    };

    const acquire = createDatabaseLeaseAcquirer({
      lock,
      onCompromised: () => {},
      staleMs: 2_000,
      updateMs: 1_000,
      retries: { retries: 5, factor: 1 }
    });
    await acquire("/canonical/db");

    expect(seenOptions).toMatchObject({
      stale: 2_000,
      update: 1_000,
      retries: { retries: 5, factor: 1 }
    });
  });

  it("forwards the onCompromised handler so a lost lock reaches the owner", async () => {
    const onCompromised = vi.fn();
    let seenOptions: LeaseLockOptions | undefined;
    const lock: LockPrimitive = async (_file, options) => {
      seenOptions = options;
      return async () => {};
    };

    const acquire = createDatabaseLeaseAcquirer({ lock, onCompromised });
    await acquire("/canonical/db");

    const compromise = new Error("lock lost");
    seenOptions?.onCompromised(compromise);
    expect(onCompromised).toHaveBeenCalledWith(compromise);
  });

  it("maps an ELOCKED rejection to a DatabaseBusyError with the stop-the-app remedy", async () => {
    const locked = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
    const lock: LockPrimitive = async () => {
      throw locked;
    };

    const acquire = createDatabaseLeaseAcquirer({ lock, onCompromised: () => {} });
    await expect(acquire("/canonical/db")).rejects.toBeInstanceOf(DatabaseBusyError);
    await expect(acquire("/canonical/db")).rejects.toMatchObject({
      message: expect.stringContaining("/canonical/db"),
      cause: locked
    });
  });

  it("rethrows a non-lock acquisition failure unchanged so real fs errors stay fail-loud", async () => {
    const permission = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const lock: LockPrimitive = async () => {
      throw permission;
    };

    const acquire = createDatabaseLeaseAcquirer({ lock, onCompromised: () => {} });
    await expect(acquire("/canonical/db")).rejects.toBe(permission);
  });
});
