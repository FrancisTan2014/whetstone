// One idempotent teardown that is live the instant the persistent database is acquired (#805), not only
// once the full server shutdown path exists. A lease compromise or a SIGINT/SIGTERM that arrives during
// migrations, backfills, or service wiring must route to a real teardown immediately — close PGlite,
// release or retain the lease per the lifecycle close-failure rule, and stop — rather than letting the
// startup sequence keep using a directory this process may no longer own.
//
// The controller owns the exactly-once guard and a single, upgradeable teardown pointer. Startup first
// installs the early database-only teardown; once the server, background drains, and signal handlers
// exist, it upgrades the pointer to the full teardown in place. Because the guard is shared across both
// phases, a compromise that fires while the upgrade is in flight still tears down exactly once.

export type Teardown = (exitCode: number) => Promise<void>;

export type ShutdownController = Readonly<{
  // Fire-and-forget dispatch for signal handlers and the compromised-lease callback, which cannot await.
  request: (exitCode: number) => void;
  // Awaitable dispatch for the startup catch, so teardown completes before control would fall through.
  run: (exitCode: number) => Promise<void>;
  // Replace the active teardown (early database-only -> full server) once the fuller path exists.
  upgrade: (teardown: Teardown) => void;
  // True once a shutdown has begun, so startup can stop advancing after a compromise.
  isShuttingDown: () => boolean;
}>;

// Build a shutdown controller around the teardown that is safe to run before the server exists.
export function createShutdownController(initialTeardown: Teardown): ShutdownController {
  let teardown = initialTeardown;
  let shuttingDown = false;

  const run = async (exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await teardown(exitCode);
  };

  return {
    request: (exitCode) => {
      void run(exitCode);
    },
    run,
    upgrade: (next) => {
      teardown = next;
    },
    isShuttingDown: () => shuttingDown
  };
}
