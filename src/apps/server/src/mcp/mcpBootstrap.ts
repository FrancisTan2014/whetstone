// Single-owner cleanup discipline for the MCP stdio bootstrap (#805), mirroring index.ts. Once the
// persistent database lease is held, EVERY later startup step — running migrations, sweeping expired
// attempts, building the lexical service, creating the card server, connecting the stdio transport —
// must, on failure, close PGlite and release-or-retain the lease before the process exits. Otherwise a
// failed MCP process stays alive holding the directory: `proper-lockfile`'s heartbeat keeps the lease
// live, so the app, backup, and the next MCP invocation are all blocked until it is killed — exactly
// the "failed startup leaves the store not reopenable" class #805 fixes for the server.

import type { ManagedDatabase } from "../db/databaseLifecycle.js";

// Run the post-open MCP bootstrap under that discipline. On any failure, close the managed database
// first — a clean close releases the lease, a failed close stays fail-loud and RETAINS the lock (per
// the lifecycle close-failure rule) so a terminated owner is reclaimed by the stale-lock path rather
// than handed the directory over an unfinished shutdown — then rethrow so the caller still exits
// non-zero. On success the database stays open for the running server; the normal shutdown/compromise
// paths own its close.
export async function runManagedBootstrap(
  managedDatabase: Pick<ManagedDatabase, "close">,
  bootstrap: () => Promise<void>
): Promise<void> {
  try {
    await bootstrap();
  } catch (error) {
    await managedDatabase.close();
    throw error;
  }
}
