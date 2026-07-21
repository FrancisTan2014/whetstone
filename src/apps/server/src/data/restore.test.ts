import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { BACKUP_FORMAT_VERSION, DATABASE_ENTRY, buildArchive, payloadRef } from "./archive.js";
import type { BackupManifest } from "./archive.js";
import type { CollectedFile } from "./fileTree.js";
import { nodeRestoreFs, restoreData, runIntegrityProbe } from "./restore.js";
import type { RestoreDatabase, RestoreFs } from "./restore.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "whetstone-restore-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function sampleArchive(): Uint8Array {
  const dbBytes = strToU8("DUMP");
  const fileBytes = strToU8("srcfile");
  const filePath = "files/sources/a.txt";
  const payloads = new Map<string, Uint8Array>([
    [DATABASE_ENTRY, dbBytes],
    [filePath, fileBytes]
  ]);
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-01-01T00:00:00.000Z",
    app: { name: "whetstone", version: "0.0.0" },
    schemaVersion: "0043_test",
    database: payloadRef(DATABASE_ENTRY, dbBytes),
    roots: [
      {
        name: "sources",
        configuredPath: "/d/sources",
        present: true,
        fileCount: 1,
        totalBytes: fileBytes.length,
        files: [{ ...payloadRef(filePath, fileBytes), relativePath: "a.txt" }]
      }
    ]
  };
  return buildArchive(manifest, payloads);
}

// A checksum-valid archive whose extraction layout is malicious: the payload's byte count and
// SHA-256 match (so verifyArchive passes), but the root name / relativePath try to escape the
// target. Restore must reject it on the safety guard, before any write.
function tamperedArchive(opts: { rootName?: string; relativePath?: string }): Uint8Array {
  const dbBytes = strToU8("DUMP");
  const fileBytes = strToU8("srcfile");
  const filePath = "files/sources/a.txt";
  const payloads = new Map<string, Uint8Array>([
    [DATABASE_ENTRY, dbBytes],
    [filePath, fileBytes]
  ]);
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-01-01T00:00:00.000Z",
    app: { name: "whetstone", version: "0.0.0" },
    schemaVersion: "0043_test",
    database: payloadRef(DATABASE_ENTRY, dbBytes),
    roots: [
      {
        name: opts.rootName ?? "sources",
        configuredPath: "/d/sources",
        present: true,
        fileCount: 1,
        totalBytes: fileBytes.length,
        files: [{ ...payloadRef(filePath, fileBytes), relativePath: opts.relativePath ?? "a.txt" }]
      }
    ]
  };
  return buildArchive(manifest, payloads);
}

function fakeFs(opts: { hasEntries?: boolean } = {}): {
  fs: RestoreFs;
  writes: { dir: string; files: CollectedFile[] }[];
} {
  const writes: { dir: string; files: CollectedFile[] }[] = [];
  const fs: RestoreFs = {
    directoryHasEntries: () => opts.hasEntries ?? false,
    ensureDir: () => {},
    writeRoot: (dir, files) => {
      writes.push({ dir, files: [...files] });
    },
    fileExists: () => true
  };
  return { fs, writes };
}

function fakeDb(opts: { migrateThrows?: boolean } = {}): {
  db: RestoreDatabase;
  calls: { migrate: number; close: number };
} {
  const calls = { migrate: 0, close: 0 };
  const db = {
    query: async (sql: string) =>
      sql.includes("from entries") ? { rows: [{ count: 3 }] } : { rows: [] },
    migrate: async () => {
      calls.migrate += 1;
      if (opts.migrateThrows) {
        throw new Error("mig fail");
      }
    },
    close: async () => {
      calls.close += 1;
    }
  } as unknown as RestoreDatabase;
  return { db, calls };
}

describe("restoreData", () => {
  it("uses the real filesystem default", async () => {
    const targetDir = join(scratch(), "target");
    const { db, calls } = fakeDb();

    const summary = await restoreData({
      archive: sampleArchive(),
      targetDir,
      openDatabase: async () => db
    });

    expect(nodeRestoreFs.fileExists(join(targetDir, "sources", "a.txt"))).toBe(true);
    expect(calls).toEqual({ migrate: 1, close: 1 });
    expect(summary.probe).toEqual({ entryCount: 3, checkedFiles: 0 });
  });

  it("verifies, writes roots, migrates, probes, and closes on success", async () => {
    const { fs, writes } = fakeFs();
    const { db, calls } = fakeDb();
    let openedDir = "";
    let openedDump: Uint8Array = new Uint8Array();

    const summary = await restoreData({
      archive: sampleArchive(),
      targetDir: "/restore",
      fs,
      openDatabase: async (databaseDir, dumpBytes) => {
        openedDir = databaseDir;
        openedDump = dumpBytes;
        return db;
      }
    });

    expect(openedDir).toBe(join("/restore", "database"));
    expect([...openedDump]).toEqual([...strToU8("DUMP")]);
    expect(calls).toEqual({ migrate: 1, close: 1 });
    expect(summary.schemaVersion).toBe("0043_test");
    expect(summary.probe).toEqual({ entryCount: 3, checkedFiles: 0 });
    expect(writes[0]!.dir).toBe(join("/restore", "sources"));
    expect(writes[0]!.files[0]!.relativePath).toBe("a.txt");
  });

  it("refuses a non-empty target directory", async () => {
    const { fs } = fakeFs({ hasEntries: true });
    await expect(
      restoreData({
        archive: sampleArchive(),
        targetDir: "/restore",
        fs,
        openDatabase: async () => fakeDb().db
      })
    ).rejects.toThrow(/already contains files/);
  });

  it("closes the database even when migration fails", async () => {
    const { db, calls } = fakeDb({ migrateThrows: true });
    await expect(
      restoreData({
        archive: sampleArchive(),
        targetDir: "/restore",
        fs: fakeFs().fs,
        openDatabase: async () => db
      })
    ).rejects.toThrow(/mig fail/);
    expect(calls.close).toBe(1);
  });

  it("rejects a traversing file path before writing or opening the database", async () => {
    const { fs, writes } = fakeFs();
    let opened = false;
    await expect(
      restoreData({
        archive: tamperedArchive({ relativePath: "../../evil.txt" }),
        targetDir: "/restore",
        fs,
        openDatabase: async () => {
          opened = true;
          return fakeDb().db;
        }
      })
    ).rejects.toThrow(/escapes its data root/);
    expect(writes).toEqual([]);
    expect(opened).toBe(false);
  });

  it("rejects an unexpected root name before writing or opening the database", async () => {
    const { fs, writes } = fakeFs();
    let opened = false;
    await expect(
      restoreData({
        archive: tamperedArchive({ rootName: "../escape" }),
        targetDir: "/restore",
        fs,
        openDatabase: async () => {
          opened = true;
          return fakeDb().db;
        }
      })
    ).rejects.toThrow(/unexpected data root/);
    expect(writes).toEqual([]);
    expect(opened).toBe(false);
  });
});

describe("runIntegrityProbe", () => {
  it("reports the entry count and verifies each referenced source file", async () => {
    const checked: string[] = [];
    const query = (async (sql: string) =>
      sql.includes("from entries")
        ? { rows: [{ count: 5 }] }
        : { rows: [{ id: "w1", file_path: "a.txt" }] }) as unknown as RestoreDatabase["query"];

    const report = await runIntegrityProbe({ query }, "/restore/sources", (path) => {
      checked.push(path);
      return true;
    });

    expect(report).toEqual({ entryCount: 5, checkedFiles: 1 });
    expect(checked).toEqual([join("/restore/sources", "a.txt")]);
  });

  it("fails when the representative query returns no rows", async () => {
    const query = (async () => ({ rows: [] })) as unknown as RestoreDatabase["query"];
    await expect(runIntegrityProbe({ query }, "/restore/sources", () => true)).rejects.toThrow(
      /returned no result/
    );
  });

  it("fails when a referenced source file is missing", async () => {
    const query = (async (sql: string) =>
      sql.includes("from entries")
        ? { rows: [{ count: 2 }] }
        : { rows: [{ id: "w9", file_path: "gone.pdf" }] }) as unknown as RestoreDatabase["query"];
    await expect(runIntegrityProbe({ query }, "/restore/sources", () => false)).rejects.toThrow(
      /work source w9 references file "gone\.pdf"/
    );
  });
});

describe("nodeRestoreFs", () => {
  it("detects empty, non-empty, and missing target directories", () => {
    const dir = scratch();
    expect(nodeRestoreFs.directoryHasEntries(dir)).toBe(false);
    writeFileSync(join(dir, "x"), "y");
    expect(nodeRestoreFs.directoryHasEntries(dir)).toBe(true);
    expect(nodeRestoreFs.directoryHasEntries(join(dir, "missing"))).toBe(false);
  });

  it("rethrows a non-ENOENT failure while probing a directory", () => {
    expect(() => nodeRestoreFs.directoryHasEntries(`${scratch()}\u0000bad`)).toThrow();
  });

  it("creates directories, checks file existence, and writes roots", () => {
    const dir = scratch();
    const target = join(dir, "sources");
    nodeRestoreFs.ensureDir(target);
    expect(nodeRestoreFs.fileExists(join(target, "a.txt"))).toBe(false);
    nodeRestoreFs.writeRoot(target, [{ relativePath: "a.txt", bytes: new Uint8Array([1]) }]);
    expect(nodeRestoreFs.fileExists(join(target, "a.txt"))).toBe(true);
  });
});
