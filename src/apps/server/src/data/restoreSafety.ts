import { posix } from "node:path";

import type { BackupManifest } from "./archive.js";
import { BackupError } from "./backupError.js";
import { IMAGE_RESOURCES_ROOT, SOURCE_FILES_ROOT } from "./dataRoots.js";

// Restore reconstructs the target directory from archive-controlled strings (`root.name` and each
// file's `relativePath`). A tampered but internally self-consistent archive — its own checksums
// match — could otherwise carry `..`, an absolute path, a Windows drive path, or a backslash
// separator and make restore write outside the intended target before the database is even opened.
// These pure guards constrain the extraction layout so a restore can never escape its target, and
// they run before any write (#600).

const KNOWN_ROOT_NAMES: ReadonlySet<string> = new Set([SOURCE_FILES_ROOT, IMAGE_RESOURCES_ROOT]);

// An absolute POSIX base used only to resolve a candidate relative path and prove it stays within.
// It never touches the real filesystem; it exists purely to make containment checkable off-host.
const CONTAINMENT_BASE = "/whetstone-restore-root";

export function assertSafeRootName(name: string): void {
  if (!KNOWN_ROOT_NAMES.has(name)) {
    const known = [...KNOWN_ROOT_NAMES].map((entry) => `"${entry}"`).join(" and ");
    throw new BackupError(
      `The backup archive declares an unexpected data root "${name}". A trusted Whetstone backup ` +
        `only contains the roots ${known}; this archive was tampered with or is from an ` +
        "incompatible build. Restore from a known-good backup file."
    );
  }
}

export function assertContainedRelativePath(rootName: string, relativePath: string): void {
  const reject = (reason: string): never => {
    throw new BackupError(
      `The backup archive maps file "${relativePath}" in root "${rootName}" to a path that ` +
        `${reason}. A restore never writes outside its target directory, so this archive was ` +
        "tampered with. Restore from a known-good backup file."
    );
  };

  if (relativePath.length === 0) {
    reject("is empty");
  }
  if (relativePath.includes("\0")) {
    reject("contains a null byte");
  }
  if (/^[A-Za-z]:/.test(relativePath)) {
    reject("is a drive-rooted Windows path");
  }
  if (relativePath.includes("\\")) {
    // Archive paths are POSIX-only, so any backslash is an attempt at Windows-style traversal.
    reject("uses a backslash separator");
  }
  // posix.resolve collapses "." and ".." against the base; an absolute or traversing path lands
  // outside CONTAINMENT_BASE and is rejected.
  const resolved = posix.resolve(CONTAINMENT_BASE, relativePath);
  if (resolved !== CONTAINMENT_BASE && !resolved.startsWith(`${CONTAINMENT_BASE}/`)) {
    reject("escapes its data root");
  }
}

export function assertSafeRestoreLayout(manifest: Pick<BackupManifest, "roots">): void {
  for (const root of manifest.roots) {
    assertSafeRootName(root.name);
    for (const file of root.files) {
      assertContainedRelativePath(root.name, file.relativePath);
    }
  }
}
