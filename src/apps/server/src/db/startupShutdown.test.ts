import { describe, expect, it, vi } from "vitest";

import { createShutdownController, type Teardown } from "./startupShutdown.js";

describe("createShutdownController", () => {
  it("routes a compromise before the full server path exists to the early teardown", async () => {
    // The exact regression (#805): during startup — before the server, drains, and full teardown are
    // wired — a lease compromise (`request(1)`) must run a REAL teardown that closes the database and
    // exits, not a no-op that lets startup keep using a directory this process may no longer own.
    const events: string[] = [];
    const earlyTeardown: Teardown = async (exitCode) => {
      events.push(`close:${exitCode}`);
    };
    const controller = createShutdownController(earlyTeardown);

    expect(controller.isShuttingDown()).toBe(false);

    controller.request(1);
    // Let the fire-and-forget dispatch settle.
    await Promise.resolve();

    expect(events).toEqual(["close:1"]);
    // Startup consults this to stop advancing after a compromise.
    expect(controller.isShuttingDown()).toBe(true);
  });

  it("runs the active teardown exactly once across repeated request/run", async () => {
    const teardown = vi.fn<Teardown>(async () => {});
    const controller = createShutdownController(teardown);

    await controller.run(0);
    controller.request(1);
    await controller.run(1);
    await Promise.resolve();

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith(0);
  });

  it("awaits the teardown so a startup catch tears down before falling through", async () => {
    const order: string[] = [];
    const teardown: Teardown = async () => {
      await Promise.resolve();
      order.push("torn-down");
    };
    const controller = createShutdownController(teardown);

    await controller.run(1);
    order.push("after-run");

    expect(order).toEqual(["torn-down", "after-run"]);
  });

  it("upgrades the active teardown in place and never double-runs across the transition", async () => {
    const events: string[] = [];
    const early: Teardown = async (code) => {
      events.push(`early:${code}`);
    };
    const full: Teardown = async (code) => {
      events.push(`full:${code}`);
    };
    const controller = createShutdownController(early);

    controller.upgrade(full);
    await controller.run(1);
    // A later compromise/signal after teardown began is a no-op — the in-flight teardown owns the exit.
    controller.request(0);
    await Promise.resolve();

    expect(events).toEqual(["full:1"]);
  });
});
