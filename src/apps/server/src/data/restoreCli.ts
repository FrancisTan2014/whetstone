import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

import { runMigrations } from "../db/migrate.js";
import { BackupError } from "./backupError.js";
import { runRestoreCommand } from "./cli.js";
import { restoreData } from "./restore.js";

// Thin real-I/O bootstrap for `pnpm data:restore`: reads the archive, creates a fresh PGlite from
// the dump, and delegates every decision to the covered cli + restore modules. Wiring only, like
// index.ts — excluded from coverage in vitest.config.ts.

const io = {
  out: (line: string) => {
    console.log(line);
  },
  err: (line: string) => {
    console.error(line);
  }
};

process.exitCode = await runRestoreCommand(
  process.argv.slice(2),
  async ({ inputPath, targetDir }) => {
    let archive: Uint8Array;
    try {
      archive = new Uint8Array(readFileSync(inputPath));
    } catch (cause) {
      throw new BackupError(
        `Could not read the backup archive at ${inputPath}. Check the --input path and try again.`,
        { cause }
      );
    }
    return await restoreData({
      archive,
      targetDir,
      openDatabase: async (databaseDir, dumpBytes) => {
        const pglite = new PGlite(databaseDir, {
          loadDataDir: new Blob([dumpBytes as unknown as BlobPart])
        });
        await pglite.waitReady;
        return {
          query: (sql) => pglite.query(sql),
          migrate: () => runMigrations(pglite),
          close: () => pglite.close()
        };
      }
    });
  },
  io
);
