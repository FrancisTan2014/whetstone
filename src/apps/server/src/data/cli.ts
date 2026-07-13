import { BackupError } from "./backupError.js";
import type { BackupSummary } from "./backup.js";
import type { RestoreSummary } from "./restore.js";

// Argument parsing, output formatting, and error-to-exit-code mapping for the backup/restore CLIs.
// Kept free of Node/PGlite wiring so it is fully unit-testable; the thin entrypoints supply the
// real `execute` that opens the database and touches the filesystem (#600).

export type CliIo = Readonly<{
  out: (line: string) => void;
  err: (line: string) => void;
}>;

const BACKUP_USAGE = "Usage: pnpm data:backup -- --output <archive-path>";
const RESTORE_USAGE =
  "Usage: pnpm data:restore -- --input <archive-path> --target <empty-directory>";

export function parseBackupArgs(argv: readonly string[]): { outputPath: string } {
  const values = parseFlags(argv, new Set(["output"]), BACKUP_USAGE);
  const outputPath = values.get("output");
  if (outputPath === undefined) {
    throw new BackupError(`Missing required --output. ${BACKUP_USAGE}`);
  }
  return { outputPath };
}

export function parseRestoreArgs(argv: readonly string[]): {
  inputPath: string;
  targetDir: string;
} {
  const values = parseFlags(argv, new Set(["input", "target"]), RESTORE_USAGE);
  const inputPath = values.get("input");
  const targetDir = values.get("target");
  if (inputPath === undefined) {
    throw new BackupError(`Missing required --input. ${RESTORE_USAGE}`);
  }
  if (targetDir === undefined) {
    throw new BackupError(`Missing required --target. ${RESTORE_USAGE}`);
  }
  return { inputPath, targetDir };
}

export async function runBackupCommand(
  argv: readonly string[],
  execute: (args: { outputPath: string }) => Promise<BackupSummary>,
  io: CliIo
): Promise<number> {
  try {
    const args = parseBackupArgs(argv);
    const summary = await execute(args);
    io.out(`Backup written to ${summary.outputPath} (${summary.archiveBytes} bytes).`);
    io.out(`  database: ${summary.databaseBytes} bytes`);
    for (const root of summary.roots) {
      const state = root.present ? `${root.fileCount} files, ${root.totalBytes} bytes` : "empty";
      io.out(`  ${root.name} (${root.configuredPath}): ${state}`);
    }
    io.out("Backup verified.");
    return 0;
  } catch (error) {
    io.err(formatError(error));
    return 1;
  }
}

export async function runRestoreCommand(
  argv: readonly string[],
  execute: (args: { inputPath: string; targetDir: string }) => Promise<RestoreSummary>,
  io: CliIo
): Promise<number> {
  try {
    const args = parseRestoreArgs(argv);
    const summary = await execute(args);
    io.out(`Restored into ${summary.targetDir} (schema ${summary.schemaVersion}).`);
    io.out(`  database: ${summary.databaseDir}`);
    for (const root of summary.roots) {
      io.out(`  ${root.name}: ${root.fileCount} files, ${root.totalBytes} bytes`);
    }
    io.out(
      `Integrity probe passed: ${summary.probe.entryCount} entries, ` +
        `${summary.probe.checkedFiles} file references checked.`
    );
    io.out(
      "Set DATABASE_DIR to the database directory above and point the file-root settings at " +
        "the restored subdirectories to use this data."
    );
    return 0;
  } catch (error) {
    io.err(formatError(error));
    return 1;
  }
}

function parseFlags(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
  usage: string
): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      throw new BackupError(`Unexpected argument "${token}". ${usage}`);
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    let name: string;
    let value: string;
    if (equals >= 0) {
      name = body.slice(0, equals);
      value = body.slice(equals + 1);
      index += 1;
    } else {
      name = body;
      const next = argv[index + 1];
      if (next === undefined) {
        throw new BackupError(`Flag --${name} needs a value. ${usage}`);
      }
      value = next;
      index += 2;
    }
    if (!allowed.has(name)) {
      throw new BackupError(`Unknown flag --${name}. ${usage}`);
    }
    values.set(name, value);
  }
  return values;
}

function formatError(error: unknown): string {
  if (error instanceof BackupError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Unexpected error: ${message}`;
}
