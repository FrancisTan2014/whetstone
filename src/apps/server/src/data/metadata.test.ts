import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { BackupError } from "./backupError.js";
import { readVersionInfo } from "./metadata.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "whetstone-meta-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeFixture(contents: Record<string, string>): {
  packageJsonPath: string;
  journalPath: string;
} {
  const dir = scratch();
  const packageJsonPath = join(dir, "package.json");
  const journalPath = join(dir, "_journal.json");
  writeFileSync(packageJsonPath, contents.packageJson ?? "");
  writeFileSync(journalPath, contents.journal ?? "");
  return { packageJsonPath, journalPath };
}

describe("readVersionInfo", () => {
  it("reads the app version and the newest migration tag from the journal", () => {
    const paths = writeFixture({
      packageJson: JSON.stringify({ name: "@whetstone/server", version: "1.2.3" }),
      journal: JSON.stringify({ entries: [{ tag: "0001_first" }, { tag: "0002_latest" }] })
    });
    expect(readVersionInfo(paths)).toEqual({
      app: { name: "@whetstone/server", version: "1.2.3" },
      schemaVersion: "0002_latest"
    });
  });

  it("reads the real repository package.json and journal by default", () => {
    const info = readVersionInfo();
    expect(info.app.name).toBe("@whetstone/server");
    expect(info.schemaVersion).toMatch(/^\d{4}_/);
  });

  it("fails loudly when the package.json cannot be read", () => {
    const paths = writeFixture({
      journal: JSON.stringify({ entries: [{ tag: "0001" }] })
    });
    expect(() =>
      readVersionInfo({
        packageJsonPath: join(paths.journalPath, "..", "missing.json"),
        journalPath: paths.journalPath
      })
    ).toThrow(/reinstall dependencies/i);
  });

  it("fails loudly when the package.json is not valid JSON", () => {
    const paths = writeFixture({
      packageJson: "{not json",
      journal: JSON.stringify({ entries: [{ tag: "0001" }] })
    });
    expect(() => readVersionInfo(paths)).toThrow(/not valid JSON/);
  });

  it("fails loudly when the package.json is not an object", () => {
    const paths = writeFixture({
      packageJson: "42",
      journal: JSON.stringify({ entries: [{ tag: "0001" }] })
    });
    expect(() => readVersionInfo(paths)).toThrow(/not a JSON object/);
  });

  it("fails loudly when the app name/version fields are missing", () => {
    const paths = writeFixture({
      packageJson: JSON.stringify({ version: "1.0.0" }),
      journal: JSON.stringify({ entries: [{ tag: "0001" }] })
    });
    expect(() => readVersionInfo(paths)).toThrow(/app name\/version/);
  });

  it("fails loudly when the migration journal has no entries", () => {
    const paths = writeFixture({
      packageJson: JSON.stringify({ name: "s", version: "1.0.0" }),
      journal: JSON.stringify({ entries: [] })
    });
    expect(() => readVersionInfo(paths)).toThrow(/no entries/);
  });

  it("fails loudly when the newest journal entry has no tag", () => {
    const paths = writeFixture({
      packageJson: JSON.stringify({ name: "s", version: "1.0.0" }),
      journal: JSON.stringify({ entries: [{ notag: true }] })
    });
    expect(() => readVersionInfo(paths)).toThrow(/malformed/);
  });

  it("wraps a non-BackupError read failure", () => {
    expect(() =>
      readVersionInfo({}, () => {
        throw new BackupError("boom");
      })
    ).toThrow(BackupError);
  });
});
