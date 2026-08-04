import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import * as lockfile from "proper-lockfile";

import { readServerConfig } from "../../config/serverConfig.js";
import { createDatabaseLeaseAcquirer } from "../../db/databaseLease.js";
import { openManagedDatabase, type ManagedDatabase } from "../../db/databaseLifecycle.js";
import {
  createFatalDatabaseGuard,
  installFatalSignalTeardown
} from "../../db/fatalDatabaseGuard.js";
import { remapPublishedPdfWork } from "./pdfWorkRemap.js";
import { RemapCommandLineError, runRemapCommand } from "./pdfWorkRemapCommandLine.js";

// Thin real-I/O bootstrap for `pnpm pdf:remap` (#861): reads server config, opens the persistent database
// through the single-owner lifecycle boundary (#805), and delegates every decision to the covered command
// and command-line modules. Wiring only, like `data:backup` — excluded from coverage in vitest.config.ts.

const io = {
  err: (line: string) => {
    console.error(line);
  },
  out: (line: string) => {
    console.log(line);
  }
};

process.exitCode = await runRemapCommand(
  process.argv.slice(2),
  async ({ workEntryId }) => {
    const config = readServerConfig();
    if (!config.databaseDir) {
      throw new RemapCommandLineError(
        "DATABASE_DIR is unset, so the database runs in memory and holds no Work to re-map. Set " +
          "DATABASE_DIR to your persistent database directory, then run the re-map again."
      );
    }
    // Take the same exclusive lease the running app holds, so a re-map can never write through a second
    // PGlite over a directory the app owns. If Whetstone is running, this fails with that remedy.
    //
    // The lease heartbeat goes live inside `openManagedDatabase`, before this binding is assigned, so the
    // compromise handler must read the handle lazily through the guard rather than a not-yet-initialized
    // `const` (a temporal-dead-zone ReferenceError).
    let managedDatabase: ManagedDatabase | undefined = undefined;
    const fatal = createFatalDatabaseGuard({
      getDatabase: () => managedDatabase,
      reportCloseError: (error) => {
        console.error("[pdf:remap] closing the database after lease compromise failed", error);
      },
      exit: (code) => process.exit(code)
    });
    // An interrupted re-map exits non-zero after closing PGlite and releasing-or-retaining the lease; the
    // content write itself is a single transaction, so an interrupt either lands it whole or not at all.
    installFatalSignalTeardown(fatal, process, 1);
    managedDatabase = await openManagedDatabase({
      databaseDir: config.databaseDir,
      openPglite: async (databaseDir) => {
        const instance = new PGlite(databaseDir);
        await instance.waitReady;
        return instance;
      },
      acquireLease: createDatabaseLeaseAcquirer({
        lock: (file, options) => lockfile.lock(file, options),
        // Losing the exclusive lease mid-re-map is fatal: another process may have reclaimed the
        // directory, so this one can no longer prove it is the sole owner and must stop writing.
        onCompromised: (error) => {
          console.error("[pdf:remap] database lease compromised; aborting re-map", error);
          fatal.trigger(1);
        }
      })
    });
    const database = managedDatabase;
    try {
      return await remapPublishedPdfWork(
        { createEntryId: () => randomUUID(), db: database.db },
        workEntryId
      );
    } finally {
      await database.close();
    }
  },
  io
);
