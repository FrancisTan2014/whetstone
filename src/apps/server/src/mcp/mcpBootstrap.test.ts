import { describe, expect, it, vi } from "vitest";

import { runManagedBootstrap } from "./mcpBootstrap.js";

describe("runManagedBootstrap", () => {
  it("closes the managed database when a post-migration startup step fails", async () => {
    // The exact regression (#805): after the lease is held, a bootstrap failure BEYOND migrations —
    // e.g. building the lexical service/card server or connecting the stdio transport — must close the
    // managed database (releasing the lease) before the error propagates, so the failed MCP process
    // never stays alive holding the persistent directory.
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push("close");
    });
    const failure = new Error("connect transport failed");

    await expect(
      runManagedBootstrap({ close }, async () => {
        order.push("migrations-ok");
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
    // The database is closed only after the bootstrap ran far enough to fail, and the original startup
    // error still propagates so the caller exits non-zero.
    expect(order).toEqual(["migrations-ok", "close"]);
  });

  it("leaves the managed database open on a successful bootstrap", async () => {
    // A healthy startup hands off to the long-lived server; the normal shutdown/compromise paths — not
    // this guard — own the eventual close, so the guard must not close a database that started cleanly.
    const close = vi.fn(async () => {});

    await runManagedBootstrap({ close }, async () => {});

    expect(close).not.toHaveBeenCalled();
  });

  it("stays fail-loud and retains the lease when the close itself fails", async () => {
    // A failed `close` means PGlite has not proven it checkpointed cleanly, so the lifecycle keeps the
    // lock held (stale-lock reclaim handles a dead owner). The guard must surface that close failure
    // rather than swallow it, keeping the failure loud.
    const closeError = new Error("pglite close failed");
    const close = vi.fn(async () => {
      throw closeError;
    });

    await expect(
      runManagedBootstrap({ close }, async () => {
        throw new Error("startup step failed");
      })
    ).rejects.toBe(closeError);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
