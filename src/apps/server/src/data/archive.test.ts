import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  BACKUP_FORMAT_VERSION,
  DATABASE_ENTRY,
  MANIFEST_ENTRY,
  buildArchive,
  payloadRef,
  readArchive,
  sha256Hex,
  verifyArchive
} from "./archive.js";
import type { BackupManifest, ParsedArchive } from "./archive.js";
import { BackupError } from "./backupError.js";

function sampleParsed(): { parsed: ParsedArchive; dbBytes: Uint8Array; fileBytes: Uint8Array } {
  const dbBytes = strToU8("db-dump-bytes");
  const fileBytes = strToU8("hello file");
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
        configuredPath: "/data/sources",
        present: true,
        fileCount: 1,
        totalBytes: fileBytes.length,
        files: [{ ...payloadRef(filePath, fileBytes), relativePath: "a.txt" }]
      }
    ]
  };
  return { parsed: { manifest, payloads }, dbBytes, fileBytes };
}

function zipWithManifest(manifestJson: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ [MANIFEST_ENTRY]: strToU8(manifestJson), ...extra });
}

describe("sha256Hex and payloadRef", () => {
  it("hashes bytes to a stable 64-char hex digest", () => {
    const digest = sha256Hex(strToU8("abc"));
    expect(digest).toHaveLength(64);
    expect(digest).toBe(sha256Hex(strToU8("abc")));
    expect(digest).not.toBe(sha256Hex(strToU8("abd")));
  });

  it("summarizes a payload's path, byte count, and checksum", () => {
    const bytes = strToU8("payload");
    expect(payloadRef("p", bytes)).toEqual({
      path: "p",
      bytes: bytes.length,
      sha256: sha256Hex(bytes)
    });
  });
});

describe("buildArchive / readArchive round-trip", () => {
  it("rebuilds the manifest and every payload and verifies clean", () => {
    const { parsed } = sampleParsed();
    const archive = buildArchive(parsed.manifest, parsed.payloads);
    const read = readArchive(archive);
    expect(read.manifest).toEqual(parsed.manifest);
    expect(read.payloads.get(DATABASE_ENTRY)).toEqual(parsed.payloads.get(DATABASE_ENTRY));
    expect(read.payloads.has(MANIFEST_ENTRY)).toBe(false);
    expect(() => verifyArchive(read)).not.toThrow();
  });
});

describe("readArchive failures", () => {
  it("rejects bytes that are not a ZIP container", () => {
    expect(() => readArchive(strToU8("not a zip"))).toThrow(/not a readable ZIP container/);
  });

  it("rejects an archive with no manifest", () => {
    const archive = zipSync({ [DATABASE_ENTRY]: strToU8("x") });
    expect(() => readArchive(archive)).toThrow(/missing its manifest\.json/);
  });

  it("rejects a manifest that is not valid JSON", () => {
    expect(() => readArchive(zipWithManifest("{not json"))).toThrow(/not valid JSON/);
  });

  it.each([
    ["a JSON array", "[]"],
    ["a JSON number", "123"]
  ])("rejects a manifest that is %s", (_label, json) => {
    expect(() => readArchive(zipWithManifest(json))).toThrow(BackupError);
  });

  it("rejects a manifest missing required top-level fields", () => {
    expect(() => readArchive(zipWithManifest(JSON.stringify({ formatVersion: 1 })))).toThrow(
      /missing required fields/
    );
  });

  it("rejects a manifest whose database payload ref is malformed", () => {
    const manifest = {
      formatVersion: 1,
      createdAt: "t",
      schemaVersion: "s",
      app: { name: "whetstone", version: "0.0.0" },
      database: { path: "d" },
      roots: []
    };
    expect(() => readArchive(zipWithManifest(JSON.stringify(manifest)))).toThrow(BackupError);
  });

  it("rejects a manifest whose root entry is malformed", () => {
    const manifest = {
      formatVersion: 1,
      createdAt: "t",
      schemaVersion: "s",
      app: { name: "whetstone", version: "0.0.0" },
      database: { path: "d", bytes: 0, sha256: "h" },
      roots: [{ name: "sources" }]
    };
    expect(() => readArchive(zipWithManifest(JSON.stringify(manifest)))).toThrow(BackupError);
  });

  it("rejects a manifest whose root file ref lacks a relativePath", () => {
    const manifest = {
      formatVersion: 1,
      createdAt: "t",
      schemaVersion: "s",
      app: { name: "whetstone", version: "0.0.0" },
      database: { path: "d", bytes: 0, sha256: "h" },
      roots: [
        {
          name: "sources",
          configuredPath: "/x",
          present: true,
          fileCount: 1,
          totalBytes: 1,
          files: [{ path: "files/sources/a", bytes: 1, sha256: "h" }]
        }
      ]
    };
    expect(() => readArchive(zipWithManifest(JSON.stringify(manifest)))).toThrow(BackupError);
  });
});

describe("verifyArchive failures", () => {
  it("rejects an incompatible format version", () => {
    const { parsed } = sampleParsed();
    const bad: ParsedArchive = {
      manifest: { ...parsed.manifest, formatVersion: 99 },
      payloads: parsed.payloads
    };
    expect(() => verifyArchive(bad)).toThrow(/format version 99/);
  });

  it("rejects a manifest that references a missing payload", () => {
    const { parsed } = sampleParsed();
    const payloads = new Map(parsed.payloads);
    payloads.delete(DATABASE_ENTRY);
    expect(() => verifyArchive({ manifest: parsed.manifest, payloads })).toThrow(
      /missing payload "database\/dump\.tar\.gz"/
    );
  });

  it("rejects a payload whose bytes no longer match the checksum", () => {
    const { parsed } = sampleParsed();
    const payloads = new Map(parsed.payloads);
    payloads.set(DATABASE_ENTRY, strToU8("tampered dump bytes!!"));
    expect(() => verifyArchive({ manifest: parsed.manifest, payloads })).toThrow(
      /does not match its manifest checksum/
    );
  });

  it("rejects a root file payload whose length matches but bytes differ", () => {
    const { parsed, fileBytes } = sampleParsed();
    const payloads = new Map(parsed.payloads);
    const sameLength = new Uint8Array(fileBytes.length).fill(65);
    payloads.set("files/sources/a.txt", sameLength);
    expect(() => verifyArchive({ manifest: parsed.manifest, payloads })).toThrow(
      /does not match its manifest checksum/
    );
  });
});
