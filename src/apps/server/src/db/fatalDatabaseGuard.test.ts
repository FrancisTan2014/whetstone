import { describe, expect, it, vi } from "vitest";

import { createFatalDatabaseGuard } from "./fatalDatabaseGuard.js";

describe("createFatalDatabaseGuard", () => {
  it("exits without touching a database that does not exist yet on a pre-assignment compromise", async () => {
    // The exact regression (#805): the lease heartbeat is live from the instant the lease is acquired,
    // BEFORE `openManagedDatabase` resolves and the caller's `managedDatabase` binding is initialized. A
    // compromise in that window must run a controlled teardown — never read a not-yet-initialized handle
    // (a temporal-dead-zone ReferenceError) — so the guard reads the handle lazily and tolerates its
    // absence: nothing owned to close yet, so exiting is the whole teardown and the lock is left for
    // stale reclaim.
    const exit = vi.fn<(code: number) => void>();
    const reportCloseError = vi.fn();
    const guard = createFatalDatabaseGuard({
      getDatabase: () => undefined,
      reportCloseError,
      exit
    });

    expect(() => guard.trigger(1)).not.toThrow();
    // Let the fire-and-forget dispatch settle.
    await Promise.resolve();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(reportCloseError).not.toHaveBeenCalled();
  });

  it("closes the managed database before exiting once it has been assigned", async () => {
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push("close");
    });
    const exit = vi.fn<(code: number) => void>(() => {
      order.push("exit");
    });
    const guard = createFatalDatabaseGuard({
      getDatabase: () => ({ close }),
      reportCloseError: vi.fn(),
      exit
    });

    guard.trigger(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    // A clean close releases the lease (in the lifecycle), then the process exits with the requested code.
    expect(order).toEqual(["close", "exit"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("stays fail-loud and exits non-zero when the close itself fails", async () => {
    // A failed close means PGlite has not proven it checkpointed cleanly, so the lifecycle keeps the lock
    // held (stale-lock reclaim handles a dead owner). The guard must report the failure and still exit —
    // and force a non-zero code even if a clean-exit code was requested.
    const closeError = new Error("pglite close failed");
    const close = vi.fn(async () => {
      throw closeError;
    });
    const reportCloseError = vi.fn();
    const exit = vi.fn<(code: number) => void>();
    const guard = createFatalDatabaseGuard({
      getDatabase: () => ({ close }),
      reportCloseError,
      exit
    });

    guard.trigger(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(reportCloseError).toHaveBeenCalledWith(closeError);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("tears down exactly once across repeated triggers", async () => {
    // A compromise and a normal signal (or two signals) may both fire; the teardown must not close the
    // database or exit twice.
    const close = vi.fn(async () => {});
    const exit = vi.fn<(code: number) => void>();
    const guard = createFatalDatabaseGuard({
      getDatabase: () => ({ close }),
      reportCloseError: vi.fn(),
      exit
    });

    guard.trigger(1);
    guard.trigger(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
