import { describe, expect, it } from "vitest";

import type { BackupSummary } from "./backup.js";
import { BackupError } from "./backupError.js";
import { parseBackupArgs, parseRestoreArgs, runBackupCommand, runRestoreCommand } from "./cli.js";
import type { RestoreSummary } from "./restore.js";

function collectIo(): {
  io: { out: (l: string) => void; err: (l: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

const backupSummary: BackupSummary = {
  outputPath: "/backups/x.zip",
  createdAt: "2026-01-01T00:00:00.000Z",
  archiveBytes: 1234,
  databaseBytes: 999,
  roots: [
    {
      name: "sources",
      configuredPath: "/data/sources",
      present: true,
      fileCount: 2,
      totalBytes: 50
    },
    { name: "images", configuredPath: "/data/images", present: false, fileCount: 0, totalBytes: 0 }
  ]
};

const restoreSummary: RestoreSummary = {
  targetDir: "/restore",
  databaseDir: "/restore/database",
  createdAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: "0043_test",
  roots: [{ name: "sources", fileCount: 2, totalBytes: 50 }],
  probe: { entryCount: 7, checkedFiles: 2 }
};

describe("parseBackupArgs", () => {
  it("reads --output as a separate token and as --output=value", () => {
    expect(parseBackupArgs(["--output", "/a.zip"])).toEqual({ outputPath: "/a.zip" });
    expect(parseBackupArgs(["--output=/b.zip"])).toEqual({ outputPath: "/b.zip" });
  });

  it("requires --output", () => {
    expect(() => parseBackupArgs([])).toThrow(/Missing required --output/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseBackupArgs(["--nope", "x"])).toThrow(/Unknown flag --nope/);
  });

  it("rejects a non-flag positional argument", () => {
    expect(() => parseBackupArgs(["oops"])).toThrow(/Unexpected argument "oops"/);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseBackupArgs(["--output"])).toThrow(/needs a value/);
  });
});

describe("parseRestoreArgs", () => {
  it("reads --input and --target", () => {
    expect(parseRestoreArgs(["--input", "/a.zip", "--target", "/out"])).toEqual({
      inputPath: "/a.zip",
      targetDir: "/out"
    });
  });

  it("requires --input", () => {
    expect(() => parseRestoreArgs(["--target", "/out"])).toThrow(/Missing required --input/);
  });

  it("requires --target", () => {
    expect(() => parseRestoreArgs(["--input", "/a.zip"])).toThrow(/Missing required --target/);
  });
});

describe("runBackupCommand", () => {
  it("prints a verified summary and returns 0", async () => {
    const { io, out, err } = collectIo();
    const code = await runBackupCommand(
      ["--output", "/backups/x.zip"],
      async () => backupSummary,
      io
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("Backup written to /backups/x.zip");
    expect(out.join("\n")).toContain("sources (/data/sources): 2 files, 50 bytes");
    expect(out.join("\n")).toContain("images (/data/images): empty");
    expect(out).toContain("Backup verified.");
  });

  it("prints the failure and returns 1 when the backup throws", async () => {
    const { io, out, err } = collectIo();
    const code = await runBackupCommand(
      ["--output", "/x.zip"],
      async () => {
        throw new BackupError("output already exists");
      },
      io
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["output already exists"]);
  });

  it("returns 1 on an argument error without invoking the backup", async () => {
    const { io, err } = collectIo();
    let invoked = false;
    const code = await runBackupCommand(
      [],
      async () => {
        invoked = true;
        return backupSummary;
      },
      io
    );
    expect(code).toBe(1);
    expect(invoked).toBe(false);
    expect(err[0]).toMatch(/Missing required --output/);
  });
});

describe("runRestoreCommand", () => {
  it("prints the restore summary and returns 0", async () => {
    const { io, out, err } = collectIo();
    const code = await runRestoreCommand(
      ["--input", "/a.zip", "--target", "/restore"],
      async () => restoreSummary,
      io
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("Restored into /restore (schema 0043_test)");
    expect(out.join("\n")).toContain(
      "Integrity probe passed: 7 entries, 2 file references checked."
    );
    expect(out.join("\n")).toContain("Set DATABASE_DIR");
  });

  it("wraps an unexpected non-BackupError failure and returns 1", async () => {
    const { io, err } = collectIo();
    const code = await runRestoreCommand(
      ["--input", "/a.zip", "--target", "/restore"],
      async () => {
        throw new Error("disk on fire");
      },
      io
    );
    expect(code).toBe(1);
    expect(err).toEqual(["Unexpected error: disk on fire"]);
  });

  it("wraps a thrown non-Error value", async () => {
    const { io, err } = collectIo();
    const code = await runRestoreCommand(
      ["--input", "/a.zip", "--target", "/restore"],
      async () => {
        throw "raw string failure";
      },
      io
    );
    expect(code).toBe(1);
    expect(err).toEqual(["Unexpected error: raw string failure"]);
  });
});
