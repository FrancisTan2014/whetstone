import { createHash } from "node:crypto";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { BackupError } from "./backupError.js";

// The archive is a single versioned ZIP container. Bump this only for a breaking change to the
// layout or manifest shape; restore refuses any other version rather than guessing (#600).
export const BACKUP_FORMAT_VERSION = 1;

export const MANIFEST_ENTRY = "manifest.json";
export const DATABASE_ENTRY = "database/dump.tar.gz";

// A payload is one addressable blob inside the archive with its exact byte count and SHA-256, so
// restore can verify every byte before it writes anything.
export type PayloadRef = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type RootFileRef = PayloadRef & Readonly<{ relativePath: string }>;

// One durable file root's inventory. A missing optional root is recorded present:false with zero
// files rather than omitted, so a restore can distinguish "was empty" from "was dropped".
export type RootManifest = Readonly<{
  name: string;
  configuredPath: string;
  present: boolean;
  fileCount: number;
  totalBytes: number;
  files: readonly RootFileRef[];
}>;

export type BackupManifest = Readonly<{
  formatVersion: number;
  createdAt: string;
  app: Readonly<{ name: string; version: string }>;
  schemaVersion: string;
  database: PayloadRef;
  roots: readonly RootManifest[];
}>;

export type ParsedArchive = Readonly<{
  manifest: BackupManifest;
  payloads: ReadonlyMap<string, Uint8Array>;
}>;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function payloadRef(path: string, bytes: Uint8Array): PayloadRef {
  return { path, bytes: bytes.length, sha256: sha256Hex(bytes) };
}

export function buildArchive(
  manifest: BackupManifest,
  payloads: ReadonlyMap<string, Uint8Array>
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2))
  };
  for (const [path, bytes] of payloads) {
    entries[path] = bytes;
  }
  return zipSync(entries);
}

export function readArchive(archive: Uint8Array): ParsedArchive {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive);
  } catch (cause) {
    throw new BackupError(
      "The backup archive is not a readable ZIP container (it may be truncated or corrupt). " +
        "Restore from a known-good backup file.",
      { cause }
    );
  }

  const manifestBytes = entries[MANIFEST_ENTRY];
  if (manifestBytes === undefined) {
    throw new BackupError(
      `The backup archive is missing its ${MANIFEST_ENTRY}; it is not a Whetstone backup or is ` +
        "corrupt. Restore from a known-good backup file."
    );
  }

  const manifest = parseManifest(strFromU8(manifestBytes));
  const payloads = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(entries)) {
    if (path !== MANIFEST_ENTRY) {
      payloads.set(path, bytes);
    }
  }
  return { manifest, payloads };
}

// Verify the whole archive (format version + every payload's presence, byte count, and checksum)
// before a restore writes anything, or before a backup reports success. Throws loudly on the first
// discrepancy with the exact payload path.
export function verifyArchive(parsed: ParsedArchive): void {
  const { manifest, payloads } = parsed;
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `The backup archive uses format version ${manifest.formatVersion}, but this build only ` +
        `understands version ${BACKUP_FORMAT_VERSION}. Restore it with a matching Whetstone build.`
    );
  }

  verifyPayload(manifest.database, payloads);
  for (const root of manifest.roots) {
    for (const file of root.files) {
      verifyPayload(file, payloads);
    }
  }
}

function verifyPayload(ref: PayloadRef, payloads: ReadonlyMap<string, Uint8Array>): void {
  const bytes = payloads.get(ref.path);
  if (bytes === undefined) {
    throw new BackupError(
      `The backup archive is missing payload "${ref.path}" declared in its manifest; the file is ` +
        "incomplete. Restore from a known-good backup file."
    );
  }
  if (bytes.length !== ref.bytes || sha256Hex(bytes) !== ref.sha256) {
    throw new BackupError(
      `The backup payload "${ref.path}" does not match its manifest checksum; the archive is ` +
        "corrupt. Restore from a known-good backup file."
    );
  }
}

function parseManifest(json: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new BackupError(
      "The backup manifest is not valid JSON; the archive is corrupt. Restore from a known-good " +
        "backup file.",
      { cause }
    );
  }

  if (!isRecord(raw)) {
    throw invalidManifest();
  }

  const formatVersion = raw.formatVersion;
  const createdAt = raw.createdAt;
  const schemaVersion = raw.schemaVersion;
  const app = raw.app;
  if (
    typeof formatVersion !== "number" ||
    typeof createdAt !== "string" ||
    typeof schemaVersion !== "string" ||
    !isRecord(app) ||
    typeof app.name !== "string" ||
    typeof app.version !== "string" ||
    !Array.isArray(raw.roots)
  ) {
    throw invalidManifest();
  }

  return {
    formatVersion,
    createdAt,
    schemaVersion,
    app: { name: app.name, version: app.version },
    database: parsePayloadRef(raw.database),
    roots: raw.roots.map(parseRootManifest)
  };
}

function parseRootManifest(raw: unknown): RootManifest {
  if (
    !isRecord(raw) ||
    typeof raw.name !== "string" ||
    typeof raw.configuredPath !== "string" ||
    typeof raw.present !== "boolean" ||
    typeof raw.fileCount !== "number" ||
    typeof raw.totalBytes !== "number" ||
    !Array.isArray(raw.files)
  ) {
    throw invalidManifest();
  }
  return {
    name: raw.name,
    configuredPath: raw.configuredPath,
    present: raw.present,
    fileCount: raw.fileCount,
    totalBytes: raw.totalBytes,
    files: raw.files.map(parseRootFileRef)
  };
}

function parseRootFileRef(raw: unknown): RootFileRef {
  const ref = parsePayloadRef(raw);
  if (!isRecord(raw) || typeof raw.relativePath !== "string") {
    throw invalidManifest();
  }
  return { ...ref, relativePath: raw.relativePath };
}

function parsePayloadRef(raw: unknown): PayloadRef {
  if (
    !isRecord(raw) ||
    typeof raw.path !== "string" ||
    typeof raw.bytes !== "number" ||
    typeof raw.sha256 !== "string"
  ) {
    throw invalidManifest();
  }
  return { path: raw.path, bytes: raw.bytes, sha256: raw.sha256 };
}

function invalidManifest(): BackupError {
  return new BackupError(
    "The backup manifest is missing required fields; the archive is corrupt or from an " +
      "incompatible Whetstone build. Restore from a known-good backup file."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
