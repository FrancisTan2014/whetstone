import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BackupError } from "./backupError.js";

// The app + schema versions stamped into a backup manifest, so a restore can tell which build and
// migration state produced the archive (#600). The schema version is the newest applied migration
// tag from Drizzle's journal — a stable identity that changes exactly when the schema does.

export type VersionInfo = Readonly<{
  app: Readonly<{ name: string; version: string }>;
  schemaVersion: string;
}>;

type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

const moduleDir = dirname(fileURLToPath(import.meta.url));

// server package.json is two levels up from src/data; migrations journal sits beside the migrator.
const defaultPackageJsonPath = join(moduleDir, "..", "..", "package.json");
const defaultJournalPath = join(moduleDir, "..", "db", "migrations", "meta", "_journal.json");

export function readVersionInfo(
  paths: { packageJsonPath?: string; journalPath?: string } = {},
  readFile: ReadFile = defaultReadFile
): VersionInfo {
  const packageJsonPath = paths.packageJsonPath ?? defaultPackageJsonPath;
  const journalPath = paths.journalPath ?? defaultJournalPath;
  return {
    app: readAppInfo(packageJsonPath, readFile),
    schemaVersion: readSchemaVersion(journalPath, readFile)
  };
}

function readAppInfo(
  packageJsonPath: string,
  readFile: ReadFile
): { name: string; version: string } {
  const raw = parseJsonFile(packageJsonPath, readFile, "package.json");
  const name = raw.name;
  const version = raw.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new BackupError(
      `Could not read the app name/version from ${packageJsonPath}. The install is incomplete; ` +
        "reinstall dependencies and try again."
    );
  }
  return { name, version };
}

function readSchemaVersion(journalPath: string, readFile: ReadFile): string {
  const raw = parseJsonFile(journalPath, readFile, "migration journal");
  const entries = raw.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new BackupError(
      `The migration journal at ${journalPath} has no entries; the install is incomplete. ` +
        "Reinstall dependencies and try again."
    );
  }
  const latest = entries[entries.length - 1] as unknown;
  if (
    typeof latest !== "object" ||
    latest === null ||
    typeof (latest as { tag?: unknown }).tag !== "string"
  ) {
    throw new BackupError(
      `The migration journal at ${journalPath} is malformed; the install is incomplete. ` +
        "Reinstall dependencies and try again."
    );
  }
  return (latest as { tag: string }).tag;
}

function parseJsonFile(path: string, readFile: ReadFile, label: string): Record<string, unknown> {
  let contents: string;
  try {
    contents = readFile(path);
  } catch (cause) {
    throw new BackupError(
      `Could not read the ${label} at ${path}. The install is incomplete; reinstall dependencies ` +
        "and try again.",
      { cause }
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new BackupError(
      `The ${label} at ${path} is not valid JSON; the install is corrupt. Reinstall dependencies ` +
        "and try again.",
      { cause }
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new BackupError(
      `The ${label} at ${path} is not a JSON object; the install is corrupt. Reinstall ` +
        "dependencies and try again."
    );
  }
  return parsed as Record<string, unknown>;
}
