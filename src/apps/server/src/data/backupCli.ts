import { PGlite } from "@electric-sql/pglite";

import * as lockfile from "proper-lockfile";

import { readServerConfig } from "../config/serverConfig.js";
import { createDatabaseLeaseAcquirer } from "../db/databaseLease.js";
import { openManagedDatabase } from "../db/databaseLifecycle.js";
import { backupData } from "./backup.js";
import { BackupError } from "./backupError.js";
import { runBackupCommand } from "./cli.js";
import { resolveDataRoots } from "./dataRoots.js";
import { readVersionInfo } from "./metadata.js";

// Thin real-I/O bootstrap for `pnpm data:backup`: reads server config, opens the persistent
// database through the single-owner lifecycle boundary (#805), and delegates every decision to the
// covered cli + backup modules. Wiring only, like index.ts — excluded from coverage in vitest.config.ts.

const io = {
  out: (line: string) => {
    console.log(line);
  },
  err: (line: string) => {
    console.error(line);
  }
};

process.exitCode = await runBackupCommand(
  process.argv.slice(2),
  async ({ outputPath }) => {
    const config = readServerConfig();
    if (!config.databaseDir) {
      throw new BackupError(
        "DATABASE_DIR is unset, so the database runs in memory and has nothing durable to back " +
          "up. Set DATABASE_DIR to your persistent database directory, then run the backup again."
      );
    }
    // Take the same lease the running app holds, so a backup can never open a second PGlite over a
    // directory the app owns. If Whetstone already owns it, this fails before PGlite construction with
    // the stop-the-running-app remedy.
    const managedDatabase = await openManagedDatabase({
      databaseDir: config.databaseDir,
      openPglite: async (databaseDir) => {
        const instance = new PGlite(databaseDir);
        await instance.waitReady;
        return instance;
      },
      acquireLease: createDatabaseLeaseAcquirer({
        lock: (file, options) => lockfile.lock(file, options),
        // Losing the exclusive lease mid-backup is fatal: another process may have reclaimed the
        // directory, so this process can no longer prove it is the sole PGlite owner. Continuing to
        // dump could overlap a reclaimed owner — exactly the unsafe concurrency #805 prevents — so
        // fail loud and abort after closing PGlite and releasing the lease, matching the server/MCP
        // fatal handling.
        onCompromised: (error) => {
          console.error("[data:backup] database lease compromised; aborting backup", error);
          void managedDatabase.close().finally(() => process.exit(1));
        }
      })
    });
    try {
      return await backupData({
        dumpDatabase: async () => {
          const dump = await managedDatabase.pglite.dumpDataDir("gzip");
          return new Uint8Array(await dump.arrayBuffer());
        },
        roots: resolveDataRoots(config),
        version: readVersionInfo(),
        outputPath
      });
    } finally {
      await managedDatabase.close();
    }
  },
  io
);
