import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { readArchive, verifyArchive } from "./archive.js";
import { backupData, nodeBackupFs } from "./backup.js";
import type { BackupFs } from "./backup.js";
import type { CollectedRoot } from "./fileTree.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "whetstone-backup-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function fakeFs(existing: Iterable<string> = []): {
  fs: BackupFs;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
} {
  const preexisting = new Set(existing);
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const fs: BackupFs = {
    exists: (path) => preexisting.has(path) || files.has(path),
    ensureDir: (dir) => {
      dirs.add(dir);
    },
    writeFile: (path, bytes) => {
      files.set(path, bytes);
    },
    readFile: (path) => files.get(path) as Uint8Array,
    rename: (from, to) => {
      files.set(to, files.get(from) as Uint8Array);
      files.delete(from);
    }
  };
  return { fs, files, dirs };
}

const version = { app: { name: "whetstone", version: "0.0.0" }, schemaVersion: "0043_test" };

function collect(path: string): CollectedRoot {
  return path.endsWith("images")
    ? { present: false, files: [] }
    : { present: true, files: [{ relativePath: "a.txt", bytes: strToU8("hi") }] };
}

describe("backupData", () => {
  it("uses the real filesystem and root collector defaults", async () => {
    const sourcesDir = scratch();
    writeFileSync(join(sourcesDir, "a.txt"), "hi");
    const outputPath = join(scratch(), "out.zip");

    const summary = await backupData({
      dumpDatabase: async () => strToU8("DUMP"),
      roots: [{ name: "sources", configuredPath: sourcesDir }],
      version,
      outputPath,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(nodeBackupFs.exists(outputPath)).toBe(true);
    expect(summary.roots).toEqual([
      {
        name: "sources",
        configuredPath: sourcesDir,
        present: true,
        fileCount: 1,
        totalBytes: 2
      }
    ]);
  });

  it("writes a verified archive, records each root, and returns a summary", async () => {
    const { fs, files, dirs } = fakeFs();
    const summary = await backupData({
      dumpDatabase: async () => strToU8("DUMP"),
      roots: [
        { name: "sources", configuredPath: "/d/sources" },
        { name: "images", configuredPath: "/d/images" }
      ],
      version,
      outputPath: "/backups/out.zip",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fs,
      collect
    });

    expect(summary.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(summary.databaseBytes).toBe(strToU8("DUMP").length);
    expect(summary.roots).toEqual([
      { name: "sources", configuredPath: "/d/sources", present: true, fileCount: 1, totalBytes: 2 },
      { name: "images", configuredPath: "/d/images", present: false, fileCount: 0, totalBytes: 0 }
    ]);
    expect(dirs.has("/backups")).toBe(true);
    expect(files.has("/backups/out.zip.partial")).toBe(false);

    const archive = files.get("/backups/out.zip") as Uint8Array;
    const parsed = readArchive(archive);
    expect(() => verifyArchive(parsed)).not.toThrow();
    expect(parsed.manifest.roots[0]!.files[0]!.relativePath).toBe("a.txt");
  });

  it("refuses to overwrite an existing output artifact", async () => {
    const { fs } = fakeFs(["/backups/out.zip"]);
    await expect(
      backupData({
        dumpDatabase: async () => strToU8("DUMP"),
        roots: [],
        version,
        outputPath: "/backups/out.zip",
        fs,
        collect
      })
    ).rejects.toThrow(/already exists/);
  });

  it("fails loudly when the written archive is truncated", async () => {
    const base = fakeFs();
    const fs: BackupFs = {
      ...base.fs,
      readFile: (path) => (base.files.get(path) as Uint8Array).slice(0, 3)
    };
    await expect(
      backupData({
        dumpDatabase: async () => strToU8("DUMP"),
        roots: [{ name: "sources", configuredPath: "/d/sources" }],
        version,
        outputPath: "/backups/out.zip",
        fs,
        collect
      })
    ).rejects.toThrow(/written incompletely/);
  });
});

describe("nodeBackupFs", () => {
  it("checks existence, creates directories, writes, reads, and renames", () => {
    const dir = scratch();
    const nested = join(dir, "a", "b");
    const target = join(nested, "f.bin");
    const renamed = join(nested, "g.bin");

    expect(nodeBackupFs.exists(target)).toBe(false);
    nodeBackupFs.ensureDir(nested);
    nodeBackupFs.writeFile(target, new Uint8Array([1, 2, 3]));
    expect(nodeBackupFs.exists(target)).toBe(true);
    expect([...nodeBackupFs.readFile(target)]).toEqual([1, 2, 3]);

    nodeBackupFs.rename(target, renamed);
    expect(nodeBackupFs.exists(target)).toBe(false);
    expect([...nodeBackupFs.readFile(renamed)]).toEqual([1, 2, 3]);
  });
});
