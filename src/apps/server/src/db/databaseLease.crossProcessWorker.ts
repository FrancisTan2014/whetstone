// Test-only child-process harness for the real cross-process database lease (#805). Spawned by
// databaseLease.crossProcess.test.ts through `node --import tsx` (the same launcher `pnpm data:backup`
// uses) so a SECOND operating-system process contends for the real `proper-lockfile` lock the server
// takes — the only way to prove the single-owner contract (reject a live competitor, hand off on
// graceful exit, reclaim after a forced kill) that an in-process fake cannot. Coverage-excluded: it is
// a spawned entrypoint, not shipped product code, and its behavior is asserted by the parent test.
//
// Protocol (argv: <databaseDir> <staleMs> <updateMs>):
//   - acquires the lease and prints "ACQUIRED" once held (or "FAILED:<message>" and exits 3),
//   - on SIGTERM releases the lease, prints "RELEASED", and exits 0 (graceful hand-off),
//   - otherwise holds the lease (heartbeat active) until killed.
// Protocol (argv: <databaseDir> <staleMs> <updateMs>):
//   - acquires the lease and prints "ACQUIRED" once held (or "FAILED:<message>" and exits 3),
//   - on the stdin line "RELEASE" (or SIGTERM where the OS delivers it) releases the lease, prints
//     "RELEASED", and exits 0 (graceful hand-off) — stdin is used because Windows cannot deliver a
//     catchable SIGTERM to a child process,
//   - otherwise holds the lease (heartbeat active) until forcibly killed.
import * as lockfile from "proper-lockfile";

import { createDatabaseLeaseAcquirer, type DatabaseLease } from "./databaseLease.js";

async function main(): Promise<void> {
  const [databaseDir, staleRaw, updateRaw] = process.argv.slice(2);
  if (databaseDir === undefined || staleRaw === undefined || updateRaw === undefined) {
    process.stderr.write("usage: <databaseDir> <staleMs> <updateMs>\n");
    process.exit(2);
  }

  const acquire = createDatabaseLeaseAcquirer({
    lock: (file, options) => lockfile.lock(file, options),
    onCompromised: (error) => {
      process.stderr.write(`COMPROMISED:${String(error)}\n`);
      process.exit(4);
    },
    staleMs: Number.parseInt(staleRaw, 10),
    updateMs: Number.parseInt(updateRaw, 10)
  });

  let lease: DatabaseLease;
  try {
    lease = await acquire(databaseDir);
  } catch (error) {
    process.stderr.write(`FAILED:${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  }

  const release = (): void => {
    void lease.release().then(() => {
      process.stdout.write("RELEASED\n");
      process.exit(0);
    });
  };
  process.on("SIGTERM", release);
  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("RELEASE")) {
      release();
    }
  });

  process.stdout.write("ACQUIRED\n");
  // Hold the lease with an active heartbeat until the parent releases it or forcibly kills us.
  setInterval(() => {}, 1_000);
}

void main();
