import { PGlite } from "@electric-sql/pglite";

import { readServerConfig } from "../config/serverConfig.js";
import { backupData } from "./backup.js";
import { BackupError } from "./backupError.js";
import { runBackupCommand } from "./cli.js";
import { resolveDataRoots } from "./dataRoots.js";
import { readVersionInfo } from "./metadata.js";

// Thin real-I/O bootstrap for `pnpm data:backup`: reads server config, opens the persistent
// database, and delegates every decision to the covered cli + backup modules. Wiring only, like
// index.ts — excluded from coverage in vitest.config.ts.

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
    const pglite = new PGlite(config.databaseDir);
    await pglite.waitReady;
    try {
      return await backupData({
        dumpDatabase: async () => {
          const dump = await pglite.dumpDataDir("gzip");
          return new Uint8Array(await dump.arrayBuffer());
        },
        roots: resolveDataRoots(config),
        version: readVersionInfo(),
        outputPath
      });
    } finally {
      await pglite.close();
    }
  },
  io
);
