import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BACKUP_FORMAT_VERSION,
  DATABASE_ENTRY,
  buildArchive,
  payloadRef,
  readArchive,
  verifyArchive
} from "./archive.js";
import type { BackupManifest, RootFileRef, RootManifest } from "./archive.js";
import { BackupError } from "./backupError.js";
import type { DataRootSpec } from "./dataRoots.js";
import { collectRoot } from "./fileTree.js";
import type { CollectedRoot } from "./fileTree.js";
import type { VersionInfo } from "./metadata.js";

// Orchestrates one backup: dump the database, gather every configured file root, assemble a
// verified versioned archive, and land it via a temp file + atomic rename. Refuses to overwrite an
// existing artifact and verifies the written bytes before reporting success (#600).

export type BackupFs = Readonly<{
  exists: (path: string) => boolean;
  ensureDir: (dir: string) => void;
  writeFile: (path: string, bytes: Uint8Array) => void;
  readFile: (path: string) => Uint8Array;
  rename: (from: string, to: string) => void;
}>;

export const nodeBackupFs: BackupFs = {
  exists: (path) => existsSync(path),
  ensureDir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  writeFile: (path, bytes) => {
    writeFileSync(path, bytes);
  },
  readFile: (path) => new Uint8Array(readFileSync(path)),
  rename: (from, to) => {
    renameSync(from, to);
  }
};

export type BackupParams = Readonly<{
  dumpDatabase: () => Promise<Uint8Array>;
  roots: readonly DataRootSpec[];
  version: VersionInfo;
  outputPath: string;
  now?: () => Date;
  fs?: BackupFs;
  collect?: (rootPath: string) => CollectedRoot;
}>;

export type BackupRootSummary = Readonly<{
  name: string;
  configuredPath: string;
  present: boolean;
  fileCount: number;
  totalBytes: number;
}>;

export type BackupSummary = Readonly<{
  outputPath: string;
  createdAt: string;
  archiveBytes: number;
  databaseBytes: number;
  roots: readonly BackupRootSummary[];
}>;

export async function backupData(params: BackupParams): Promise<BackupSummary> {
  const fs = params.fs ?? nodeBackupFs;
  const collect = params.collect ?? collectRoot;
  const now = params.now ?? (() => new Date());
  const { outputPath } = params;

  if (fs.exists(outputPath)) {
    throw new BackupError(
      `A file already exists at the backup output ${outputPath}. Choose a different --output path ` +
        "or remove the existing file; a backup never overwrites an existing artifact."
    );
  }

  const databaseBytes = await params.dumpDatabase();
  const payloads = new Map<string, Uint8Array>();
  payloads.set(DATABASE_ENTRY, databaseBytes);

  const roots: RootManifest[] = params.roots.map((root) =>
    buildRootManifest(root, collect(root.configuredPath), payloads)
  );

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now().toISOString(),
    app: params.version.app,
    schemaVersion: params.version.schemaVersion,
    database: payloadRef(DATABASE_ENTRY, databaseBytes),
    roots
  };

  const archive = buildArchive(manifest, payloads);
  // Verify the complete archive we just built before touching disk.
  verifyArchive(readArchive(archive));

  fs.ensureDir(dirname(outputPath));
  const tempPath = `${outputPath}.partial`;
  fs.writeFile(tempPath, archive);

  // Re-read what actually landed on disk and verify it, so a partial or corrupt write fails loudly
  // instead of leaving a broken "backup" behind.
  const written = fs.readFile(tempPath);
  if (written.length !== archive.length) {
    throw new BackupError(
      `The backup at ${tempPath} was written incompletely (${written.length} of ${archive.length} ` +
        `bytes). Free up disk space, remove ${tempPath}, and run the backup again.`
    );
  }
  verifyArchive(readArchive(written));

  fs.rename(tempPath, outputPath);

  return {
    outputPath,
    createdAt: manifest.createdAt,
    archiveBytes: archive.length,
    databaseBytes: databaseBytes.length,
    roots: roots.map((root) => ({
      name: root.name,
      configuredPath: root.configuredPath,
      present: root.present,
      fileCount: root.fileCount,
      totalBytes: root.totalBytes
    }))
  };
}

function buildRootManifest(
  root: DataRootSpec,
  collected: CollectedRoot,
  payloads: Map<string, Uint8Array>
): RootManifest {
  const files: RootFileRef[] = collected.files.map((file) => {
    const path = `files/${root.name}/${file.relativePath}`;
    payloads.set(path, file.bytes);
    return { ...payloadRef(path, file.bytes), relativePath: file.relativePath };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    name: root.name,
    configuredPath: root.configuredPath,
    present: collected.present,
    fileCount: files.length,
    totalBytes,
    files
  };
}
