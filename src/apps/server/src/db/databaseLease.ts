// A persistent PGlite directory has exactly one process owner at a time (#805). This module owns the
// cross-process exclusive lease that ownership rests on: a process must hold the lease before it
// constructs PGlite over a directory, and must release it only after `pglite.close()` completes. Two
// embedded PostgreSQL runtimes mutating one WAL corrupts the store
// (https://github.com/electric-sql/pglite/issues/327), so this boundary makes ownership explicit
// instead of an accident of which command started first.
//
// The lease is a `proper-lockfile` mkdir lock with a heartbeat: the owner refreshes the lock mtime on
// an interval, so a live owner is never displaced, while a lock left by a terminated process becomes
// stale after the threshold and is reclaimed atomically — without ever touching, deleting, or
// resetting the database directory itself. The proven library handles the mtime probe, the
// stale-vs-live decision, and the race-safe reclaim; we never hand-roll an unchecked sentinel file.

// The forwarded subset of `proper-lockfile`'s lock options this boundary controls. Kept structural so
// the real `proper-lockfile.lock` and a test fake satisfy the same `LockPrimitive` port.
export type LeaseRetryOptions = Readonly<{
  retries: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
}>;

export type LeaseLockOptions = Readonly<{
  stale: number;
  update: number;
  realpath: boolean;
  retries: number | LeaseRetryOptions;
  onCompromised: (error: Error) => void;
}>;

// The cross-process lock primitive: acquires an exclusive lock over `file` and resolves a release
// function, or rejects (e.g. `ELOCKED`) when another live owner already holds it. `proper-lockfile.lock`
// is the production implementation; tests inject a fake with the same shape.
export type LockPrimitive = (
  file: string,
  options: LeaseLockOptions
) => Promise<() => Promise<void>>;

// A held lease. `release` frees the lock so another process can take ownership; it must be called only
// after the owner has closed PGlite.
export type DatabaseLease = Readonly<{
  release: () => Promise<void>;
}>;

// Acquire an exclusive lease over an already-canonicalized persistent database directory.
export type AcquireDatabaseLease = (canonicalDatabaseDir: string) => Promise<DatabaseLease>;

// Consider a lock abandoned once its heartbeat is this far stale. Comfortably above the update interval
// so a live-but-busy owner (a long checkpoint, GC pause) is never mistaken for dead, yet short enough
// that a crashed owner's directory becomes reclaimable without operator intervention. The heartbeat
// timer is independent of database load, so a live owner refreshes the lock regardless of query volume.
export const DATABASE_LEASE_STALE_MS = 15_000;

// Refresh the lock mtime this often. Several refreshes fit inside the stale window, so a single missed
// tick never falsely marks a live owner stale.
export const DATABASE_LEASE_UPDATE_MS = 5_000;

// Raised when another live Whetstone process already owns the database directory. Carries the exact
// remedy so a competing start fails loudly before PGlite construction instead of racing into the WAL.
export class DatabaseBusyError extends Error {
  override readonly name = "DatabaseBusyError";

  constructor(databaseDir: string, options?: { cause?: unknown }) {
    super(
      `Another Whetstone process already owns the database directory ${databaseDir}. Stop the ` +
        `running app (or other database command) and let it shut down, then try again.`,
      options
    );
  }
}

function isLockedError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ELOCKED"
  );
}

export type CreateDatabaseLeaseAcquirerOptions = Readonly<{
  // The cross-process lock primitive (`proper-lockfile.lock` in production).
  lock: LockPrimitive;
  // Invoked if the heartbeat can no longer prove exclusive ownership (the lock was deleted or the
  // process stalled past the stale threshold). The owner must treat this as fatal and shut down, since
  // another process may now reclaim the directory.
  onCompromised: (error: Error) => void;
  // Override the stale/update timings (tests use a short window). Defaults to the production constants.
  staleMs?: number;
  updateMs?: number;
  // How long to wait for a departing owner to release before failing. `0` (the default, used by
  // maintenance commands) fails immediately; the server passes a small bounded retry so a development
  // watch reload hands the lease from the exiting process to its replacement without a spurious error.
  retries?: number | LeaseRetryOptions;
}>;

// Build the production lease acquirer over the injected lock primitive. `realpath` is false because the
// caller passes an already-canonicalized directory, so the lock path is derived deterministically and
// two processes reaching the same directory by different relative paths still contend on one lock.
export function createDatabaseLeaseAcquirer(
  options: CreateDatabaseLeaseAcquirerOptions
): AcquireDatabaseLease {
  const stale = options.staleMs ?? DATABASE_LEASE_STALE_MS;
  const update = options.updateMs ?? DATABASE_LEASE_UPDATE_MS;
  const retries = options.retries ?? 0;

  return async (canonicalDatabaseDir) => {
    let release: () => Promise<void>;
    try {
      release = await options.lock(canonicalDatabaseDir, {
        stale,
        update,
        realpath: false,
        retries,
        onCompromised: options.onCompromised
      });
    } catch (error) {
      if (isLockedError(error)) {
        throw new DatabaseBusyError(canonicalDatabaseDir, { cause: error });
      }
      throw error;
    }

    return {
      release: async () => {
        await release();
      }
    };
  };
}
