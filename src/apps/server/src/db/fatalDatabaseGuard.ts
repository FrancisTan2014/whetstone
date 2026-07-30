// A single idempotent teardown for a maintenance/stdio command that owns a persistent database (#805),
// safe to invoke BEFORE the managed handle is assigned. The lease heartbeat is live from the instant the
// lease is acquired — inside `openManagedDatabase`, before it resolves and before the caller's
// `managedDatabase` binding is initialized — so a lease compromise (or a shutdown signal) in that window
// must not read a not-yet-initialized `const` (a temporal-dead-zone `ReferenceError`) and must not let
// startup keep using a directory this process may no longer own. Instead it runs a controlled teardown:
// close the managed database when it exists yet (a clean close releases the lease; a failed close stays
// fail-loud and RETAINS the lock so a terminated owner is reclaimed by the stale-lock path, never handed
// the directory over an unfinished shutdown), then exit. Idempotent, so a compromise and a normal signal
// never tear down twice.
//
// The server (index.ts) needs a two-phase upgradeable teardown (startupShutdown.ts); the single-phase
// commands (backup CLI, MCP stdio) only need this: a lazily-read handle plus close-or-exit.

import type { ManagedDatabase } from "./databaseLifecycle.js";

export type FatalDatabaseGuard = Readonly<{
  // Fire-and-forget teardown for signal handlers and the compromised-lease callback, which cannot await.
  // Idempotent: repeated calls after the first are no-ops.
  trigger: (exitCode: number) => void;
}>;

export type FatalDatabaseGuardOptions = Readonly<{
  // Read the managed database lazily. `undefined` while the lease is still being acquired, so the guard
  // is safe to wire before `openManagedDatabase` resolves and the caller's handle exists.
  getDatabase: () => Pick<ManagedDatabase, "close"> | undefined;
  // Report a failed close (a clean close is silent). The command's console/stderr writer.
  reportCloseError: (error: unknown) => void;
  // Terminate the process. Injected so the teardown is unit-testable without killing the test runner.
  exit: (exitCode: number) => void;
}>;

export function createFatalDatabaseGuard(options: FatalDatabaseGuardOptions): FatalDatabaseGuard {
  let tearingDown = false;

  const run = async (exitCode: number): Promise<void> => {
    let code = exitCode;
    try {
      // `undefined` only in the pre-assignment window: there is no owned PGlite to close yet, so exiting
      // is the whole teardown and the internal lock is left for the stale-lock reclaim path.
      await options.getDatabase()?.close();
    } catch (error) {
      // A failed close kept the lease held on purpose; still exit non-zero so the failure is loud.
      options.reportCloseError(error);
      code = 1;
    }
    options.exit(code);
  };

  return {
    trigger: (exitCode) => {
      if (tearingDown) {
        return;
      }
      tearingDown = true;
      void run(exitCode);
    }
  };
}

// The minimal signal surface the teardown needs, so the wiring is unit-testable without registering
// real handlers on the test runner's process.
export type SignalTeardownRegistrar = Readonly<{
  on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
}>;

// Route SIGINT/SIGTERM through the guard so a normal interruption of a command that owns an existing
// persistent database closes PGlite (checkpointing) and releases-or-retains the lease before the process
// exits, instead of abandoning the open runtime for stale-lock recovery after an abrupt exit (#805).
// Wired the instant the guard exists — before the post-open bootstrap (MCP) or the long dump (backup)
// runs — so a Ctrl+C in the post-open/pre-bootstrap window still tears down cleanly, mirroring index.ts,
// which registers a stable signal handler at acquisition. The guard reads the handle lazily, so a signal
// before it is assigned simply exits, leaving the lock for the stale-lock path.
export function installFatalSignalTeardown(
  guard: FatalDatabaseGuard,
  registrar: SignalTeardownRegistrar,
  exitCode: number
): void {
  const onSignal = (): void => {
    guard.trigger(exitCode);
  };
  registrar.on("SIGINT", onSignal);
  registrar.on("SIGTERM", onSignal);
}
