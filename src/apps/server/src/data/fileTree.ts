import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

import { BackupError } from "./backupError.js";

// Reads and writes a durable file root as a flat list of files. A configured-but-missing root is
// reported empty (present:false); a configured root that exists but cannot be walked (e.g. it is a
// file, not a directory) fails loudly with its exact path — never silently skipped (#600).

export type CollectedFile = Readonly<{
  relativePath: string;
  bytes: Uint8Array;
}>;

export type CollectedRoot = Readonly<{
  present: boolean;
  files: CollectedFile[];
}>;

export function collectRoot(rootPath: string): CollectedRoot {
  let stats;
  try {
    stats = statSync(rootPath);
  } catch (error) {
    if (isEnoent(error)) {
      return { present: false, files: [] };
    }
    throw new BackupError(
      `Could not read the configured data root at ${rootPath}. Fix its path or permissions, then ` +
        "run the backup again.",
      { cause: error }
    );
  }

  if (!stats.isDirectory()) {
    throw new BackupError(
      `The configured data root at ${rootPath} is not a directory. Point the setting at the ` +
        "directory that holds the files, then run the backup again."
    );
  }

  const files: CollectedFile[] = [];
  walk(rootPath, rootPath, files);
  // Relative paths within a single root are unique; sort for a stable, reproducible manifest.
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { present: true, files };
}

function walk(rootPath: string, current: string, files: CollectedFile[]): void {
  for (const dirent of readdirSync(current, { withFileTypes: true })) {
    const childPath = join(current, dirent.name);
    if (dirent.isDirectory()) {
      walk(rootPath, childPath, files);
    } else {
      const bytes = new Uint8Array(readFileSync(childPath));
      files.push({ relativePath: toPosixRelative(rootPath, childPath), bytes });
    }
  }
}

export function writeRoot(targetDir: string, files: Iterable<CollectedFile>): void {
  for (const file of files) {
    const destination = join(targetDir, ...file.relativePath.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
  }
}

function toPosixRelative(rootPath: string, childPath: string): string {
  // split(sep).join("/") is a no-op on POSIX and normalizes separators on Windows, so the archive
  // always stores forward-slash relative paths regardless of host.
  return relative(rootPath, childPath).split(sep).join(posix.sep);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
