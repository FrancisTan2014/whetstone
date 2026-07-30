// The single server-owned database lifecycle boundary (#805). Every command that opens the persistent
// PGlite store — the server, the development reloader, the MCP surface, and maintenance commands — goes
// through here so ownership is uniform: canonicalize the directory, acquire the cross-process lease
// FIRST, construct PGlite only after the lease is held, and release the lease only after
// `pglite.close()` has completed. An in-memory database (no persistent directory) needs no lease: no
// WAL on disk, nothing to corrupt.
//
// `close` is idempotent by construction, so a signal handler, a startup-failure path, and a normal
// shutdown can all call it and PGlite is closed and the lease released exactly once. The lease is
// released only AFTER `pglite.close()` resolves: a failing close stays fail-loud and keeps the lock
// held, because the embedded runtime has not proven it checkpointed cleanly and no other process may
// take the directory yet. A terminated owner is reclaimed by the cross-process stale-lock recovery
// path, never by handing an unverified directory to a new owner here.

import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

import { createDbClient, type DbClient } from "./dbClient.js";
import type { AcquireDatabaseLease, DatabaseLease } from "./databaseLease.js";

// Construct PGlite over the given directory, or in memory when `databaseDir` is undefined. Kept as an
// injected port so the lifecycle logic is exercised without a real embedded PostgreSQL, and so each
// entrypoint supplies its own construction (the restore path, for instance, loads from a dump).
export type OpenPglite = (databaseDir: string | undefined) => Promise<PGlite>;

// A live, owned database plus the one handle that relinquishes it. `databaseDir` is the canonical
// persistent directory this process owns, or undefined for an in-memory database.
export type ManagedDatabase = Readonly<{
  pglite: PGlite;
  db: DbClient;
  databaseDir: string | undefined;
  close: () => Promise<void>;
}>;

export type OpenManagedDatabaseOptions = Readonly<{
  // The configured directory: undefined or blank means in-memory (no lease).
  databaseDir: string | undefined;
  openPglite: OpenPglite;
  acquireLease: AcquireDatabaseLease;
  // Resolve a configured directory to its canonical on-disk path, creating it if missing. Overridable
  // for tests; the default resolves, creates, and realpath-normalizes so two processes reaching one
  // directory by different paths contend on the same lease.
  canonicalizeDir?: (databaseDir: string) => string;
  // Build the Drizzle client over PGlite. Defaults to the shared `createDbClient`.
  createDb?: (pglite: PGlite) => DbClient;
}>;

function canonicalizeDatabaseDir(databaseDir: string): string {
  const resolved = resolve(databaseDir);
  // PGlite does not create missing parent directories and `proper-lockfile` needs the parent to exist;
  // creating the directory up front makes both the lock and the canonical realpath resolvable.
  mkdirSync(resolved, { recursive: true });
  return realpathSync(resolved);
}

function isPersistent(databaseDir: string | undefined): databaseDir is string {
  return databaseDir !== undefined && databaseDir.trim() !== "";
}

function buildManagedDatabase(
  pglite: PGlite,
  databaseDir: string | undefined,
  createDb: (pglite: PGlite) => DbClient,
  lease: DatabaseLease | undefined
): ManagedDatabase {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    // Close PGlite first. If it rejects, we stay fail-loud (rethrow) and DO NOT release the lease:
    // the runtime has not cleanly closed/checkpointed, so releasing the lock could let another owner
    // acquire the directory over an unfinished shutdown and recreate the overlap this fix prevents.
    // The stale-lock recovery path reclaims a truly terminated owner instead.
    await pglite.close();
    closed = true;
    if (lease !== undefined) {
      await lease.release();
    }
  };

  return { pglite, db: createDb(pglite), databaseDir, close };
}

// Open the database under single-owner ownership. Persistent directories acquire the lease before
// PGlite is constructed and, if construction fails, the lease is released so a retry is never blocked
// by the failed attempt. In-memory databases skip the lease entirely.
export async function openManagedDatabase(
  options: OpenManagedDatabaseOptions
): Promise<ManagedDatabase> {
  const createDb = options.createDb ?? createDbClient;

  if (!isPersistent(options.databaseDir)) {
    const pglite = await options.openPglite(undefined);
    return buildManagedDatabase(pglite, undefined, createDb, undefined);
  }

  const canonicalize = options.canonicalizeDir ?? canonicalizeDatabaseDir;
  const canonicalDir = canonicalize(options.databaseDir);
  const lease = await options.acquireLease(canonicalDir);

  let pglite: PGlite;
  try {
    pglite = await options.openPglite(canonicalDir);
  } catch (error) {
    await lease.release();
    throw error;
  }

  return buildManagedDatabase(pglite, canonicalDir, createDb, lease);
}
