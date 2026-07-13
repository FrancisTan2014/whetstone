import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DATABASE_ENTRY, readArchive, verifyArchive } from "./archive.js";
import { BackupError } from "./backupError.js";
import { RESTORE_DATABASE_SUBDIR, SOURCE_FILES_ROOT } from "./dataRoots.js";
import { writeRoot } from "./fileTree.js";
import type { CollectedFile } from "./fileTree.js";

// Orchestrates one restore into a fresh, empty target directory: verify the archive end to end
// before writing anything, lay out the database dump and every file root, load the database, run
// current migrations, then run an integrity probe that opens the database and checks representative
// row and file references. Any failure is loud, with the exact safe remedy (#600).

export type RestoreDatabase = Readonly<{
  query: <T = Record<string, unknown>>(sql: string) => Promise<{ rows: T[] }>;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}>;

export type RestoreFs = Readonly<{
  directoryHasEntries: (dir: string) => boolean;
  ensureDir: (dir: string) => void;
  writeRoot: (targetDir: string, files: Iterable<CollectedFile>) => void;
  fileExists: (path: string) => boolean;
}>;

export const nodeRestoreFs: RestoreFs = {
  directoryHasEntries: (dir) => {
    try {
      return readdirSync(dir).length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  },
  ensureDir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  writeRoot,
  fileExists: (path) => existsSync(path)
};

export type RestoreParams = Readonly<{
  archive: Uint8Array;
  targetDir: string;
  openDatabase: (databaseDir: string, dumpBytes: Uint8Array) => Promise<RestoreDatabase>;
  fs?: RestoreFs;
}>;

export type ProbeReport = Readonly<{
  entryCount: number;
  checkedFiles: number;
}>;

export type RestoreRootSummary = Readonly<{
  name: string;
  fileCount: number;
  totalBytes: number;
}>;

export type RestoreSummary = Readonly<{
  targetDir: string;
  databaseDir: string;
  createdAt: string;
  schemaVersion: string;
  roots: readonly RestoreRootSummary[];
  probe: ProbeReport;
}>;

export async function restoreData(params: RestoreParams): Promise<RestoreSummary> {
  const fs = params.fs ?? nodeRestoreFs;
  const { targetDir } = params;

  // Verify version + every checksum before writing a single byte to the target.
  const parsed = readArchive(params.archive);
  verifyArchive(parsed);
  const { manifest, payloads } = parsed;

  if (fs.directoryHasEntries(targetDir)) {
    throw new BackupError(
      `The restore target ${targetDir} already contains files. Restore only into a new, empty ` +
        "directory so an existing data root is never overwritten; choose a different --target."
    );
  }

  fs.ensureDir(targetDir);

  for (const root of manifest.roots) {
    const files: CollectedFile[] = root.files.map((file) => ({
      relativePath: file.relativePath,
      // Presence is guaranteed by verifyArchive above.
      bytes: payloads.get(file.path) as Uint8Array
    }));
    fs.writeRoot(join(targetDir, root.name), files);
  }

  const databaseDir = join(targetDir, RESTORE_DATABASE_SUBDIR);
  const dumpBytes = payloads.get(DATABASE_ENTRY) as Uint8Array;
  const db = await params.openDatabase(databaseDir, dumpBytes);
  try {
    await db.migrate();
    const probe = await runIntegrityProbe(db, join(targetDir, SOURCE_FILES_ROOT), fs.fileExists);
    return {
      targetDir,
      databaseDir,
      createdAt: manifest.createdAt,
      schemaVersion: manifest.schemaVersion,
      roots: manifest.roots.map((root) => ({
        name: root.name,
        fileCount: root.fileCount,
        totalBytes: root.totalBytes
      })),
      probe
    };
  } finally {
    await db.close();
  }
}

export async function runIntegrityProbe(
  db: Pick<RestoreDatabase, "query">,
  sourcesDir: string,
  fileExists: (path: string) => boolean
): Promise<ProbeReport> {
  const entryResult = await db.query<{ count: number }>(
    "select count(*)::int as count from entries"
  );
  const firstRow = entryResult.rows[0];
  if (firstRow === undefined) {
    throw new BackupError(
      "Integrity probe failed: the restored database returned no result for a representative " +
        "query, so it is unreadable. Discard the target directory and restore from a known-good backup."
    );
  }

  const sourceResult = await db.query<{ id: string; file_path: string }>(
    "select id, file_path from work_sources where kind = 'upload' and file_path is not null"
  );
  for (const row of sourceResult.rows) {
    const absolute = join(sourcesDir, ...row.file_path.split("/"));
    if (!fileExists(absolute)) {
      throw new BackupError(
        `Integrity probe failed: work source ${row.id} references file "${row.file_path}", but it ` +
          `is missing from the restored source files at ${sourcesDir}. The archive is incomplete; ` +
          "discard the target directory and restore from a known-good backup."
      );
    }
  }

  return { entryCount: Number(firstRow.count), checkedFiles: sourceResult.rows.length };
}
