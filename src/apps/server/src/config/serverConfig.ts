import type { FastifyServerOptions } from "fastify";

import { MAX_STAGED_BYTES } from "@whetstone/contracts";

export type ServerLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

// The structured PDF worker (#701/#782) enforces one worker-owned memory-boundary contract on every
// supported host, but the committed-memory floor differs by platform: Docling's torch/MKL layout+table
// runtime commits roughly twice as much on Windows as on POSIX, so a POSIX-calibrated 2 GiB ceiling
// hard-fails every real Windows conversion (measured ~3.9 GiB peak, #782). These are the two platform
// defaults; PDF_STRUCTURED_MEMORY_MIB overrides either on every platform.
export const POSIX_STRUCTURED_PDF_MEMORY_MIB = 2048;
export const WINDOWS_STRUCTURED_PDF_MEMORY_MIB = 6144;

// The single owner of the structured PDF worker's wall-clock timeout. Production kills a slow spawn here
// (422) and the #779 corpus harness must gate on the SAME bound, so neither duplicates the number: both
// resolve it through `resolveStructuredPdfTimeoutMs`. Overridable with PDF_TIMEOUT_MS (see below).
export const DEFAULT_PDF_TIMEOUT_MS = 180_000;

// Resolve the worker timeout (ms): an explicit positive-integer PDF_TIMEOUT_MS / --timeout-ms value wins;
// absent, the production default applies. Rejects a non-positive or non-integer override so the worker
// never runs with a broken timeout. The single owner production (this config) and the harness both consume,
// so a gate-producing harness run uses the exact production bound instead of a duplicated 15-minute default.
export function resolveStructuredPdfTimeoutMs(override: string | undefined): number {
  if (override === undefined) {
    return DEFAULT_PDF_TIMEOUT_MS;
  }

  const timeout = Number.parseInt(override, 10);

  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("PDF_TIMEOUT_MS must be a positive integer number of milliseconds.");
  }

  return timeout;
}

// The single, pure, platform-injectable owner of the per-child structured PDF memory default. Production
// (this config) and the #779 corpus harness both consume it, so neither duplicates the platform numbers.
export function defaultStructuredPdfMemoryMib(
  platform: NodeJS.Platform = process.platform
): number {
  return platform === "win32" ? WINDOWS_STRUCTURED_PDF_MEMORY_MIB : POSIX_STRUCTURED_PDF_MEMORY_MIB;
}

// Resolve the per-child ceiling: an explicit positive-integer PDF_STRUCTURED_MEMORY_MIB / --memory-mib
// value wins on every platform; absent, the platform-aware default applies. Rejects a non-positive or
// non-integer override so the worker never runs with a broken ceiling.
export function resolveStructuredPdfMemoryMib(
  override: string | undefined,
  platform: NodeJS.Platform = process.platform
): number {
  if (override === undefined) {
    return defaultStructuredPdfMemoryMib(platform);
  }

  const memory = Number.parseInt(override, 10);

  if (!Number.isInteger(memory) || memory < 1) {
    throw new Error("PDF_STRUCTURED_MEMORY_MIB must be a positive integer number of MiB.");
  }

  return memory;
}

export type ServerConfig = Readonly<{
  databaseDir: string | undefined;
  epubUploadLimitBytes: number;
  host: string;
  imageResourcesDir: string;
  logLevel: ServerLogLevel;
  pdfOcrBinary: string;
  // The Tesseract binary the OCR toolchain inspector (#745) lists installed trained-data packs from, so
  // the bounded OCR adapter can fail with a named language-pack error before spawning. Env-overridable.
  pdfTesseractBinary: string;
  pdfImportStageDir: string;
  // Upload cap (bytes) for the born-digital PDF import front door (#702). Aligned with the structured
  // PDF staging bound (`MAX_STAGED_BYTES`, 128 MiB) so a supported PDF is streamed into the staged
  // attempt and handled by the PDF-specific stage/runner contract, never rejected early by the
  // unrelated 50 MiB EPUB body limit. Env-overridable (PDF_UPLOAD_LIMIT_BYTES).
  pdfUploadLimitBytes: number;
  pdfPythonBinary: string;
  pdfTimeoutMs: number;
  // Per-child hard memory ceiling (MiB) the structured PDF worker (#701) self-applies through its
  // platform boundary (POSIX RLIMIT_AS; Windows Job Object, #782). Platform-aware by default and
  // overridable with PDF_STRUCTURED_MEMORY_MIB (see resolveStructuredPdfMemoryMib).
  pdfStructuredMemoryMib: number;
  // Dev/E2E only: convert born-digital PDF imports from an embedded fixture in the uploaded bytes instead
  // of the real Docling worker, so the journey runs without a Python/Docling install. Never set in
  // production — a real upload there is converted by the real runner or fails visibly.
  pdfImportFixtureConversion: boolean;
  // Dev/E2E only: run the OCR phase (#745) with a deterministic fixture that transforms the embedded
  // conversion fixture (text-less pages -> native with recovered text) instead of the real OCRmyPDF
  // pass, so a scanned/mixed English import honestly publishes without any OCR tool installed. Never set
  // in production — a real scanned upload there is OCR'd by the real adapter or fails visibly.
  pdfImportFixtureOcr: boolean;
  port: number;
  sourceFilesDir: string;
  // Ordinary Work-creation upload stages (#725): transient per-attempt staged markdown/EPUB bytes held by
  // a `work_creation_attempts` row while duplicate review is pending, SEPARATE from immutable source
  // provenance under sourceFilesDir. Like `pdfImportStageDir` it is deliberately NOT a backed-up data root
  // (see `resolveDataRoots`), so a cancelled/expired attempt's bytes are freed without touching provenance
  // and a restore recreates no live stage. Env-overridable.
  workCreationStageDir: string;
  webDir: string | undefined;
}>;

const defaultServerConfig: ServerConfig = {
  databaseDir: undefined,
  epubUploadLimitBytes: 50 * 1024 * 1024,
  host: "127.0.0.1",
  imageResourcesDir: "./.data/images",
  logLevel: "info",
  pdfOcrBinary: "ocrmypdf",
  pdfTesseractBinary: "tesseract",
  // Recoverable PDF import stages (#721): transient per-attempt staged bytes, SEPARATE from immutable
  // source provenance under sourceFilesDir, so they are never backed up and a cancelled/failed/expired
  // attempt's bytes are freed without touching provenance. Env-overridable.
  pdfImportStageDir: "./.data/pdf-import-stages",
  pdfPythonBinary: "python",
  // Aligned with the structured PDF staging bound (`MAX_STAGED_BYTES`) so the import front door accepts
  // every supported PDF up to the contract limit. Env-overridable (PDF_UPLOAD_LIMIT_BYTES).
  pdfUploadLimitBytes: MAX_STAGED_BYTES,
  // Docling's per-page layout + table analysis is slow; oversized/scanned books can run for many
  // minutes. Bound the spawn so a slow PDF is killed and rejected (422) instead of hanging the
  // ingest request. v0 targets born-digital, reasonably-sized PDFs (#403). Env-overridable.
  pdfTimeoutMs: DEFAULT_PDF_TIMEOUT_MS,
  // Nominal POSIX baseline; the real per-child ceiling is resolved platform-aware in readServerConfig
  // (POSIX 2 GiB, Windows 6 GiB — see resolveStructuredPdfMemoryMib). Env-overridable
  // (PDF_STRUCTURED_MEMORY_MIB) on every platform.
  pdfStructuredMemoryMib: POSIX_STRUCTURED_PDF_MEMORY_MIB,
  // Off by default: production converts with the real Docling worker (or fails visibly), never a fixture.
  pdfImportFixtureConversion: false,
  // Off by default: production OCRs with the real bounded adapter (or fails visibly), never a fixture.
  pdfImportFixtureOcr: false,
  port: 3000,
  sourceFilesDir: "./.data/sources",
  workCreationStageDir: "./.data/work-creation-stages",
  webDir: undefined
};

const serverLogLevels = new Set<ServerLogLevel>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent"
]);

export function readServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ServerConfig {
  const port = parsePort(env.PORT);
  const logLevel = parseLogLevel(env.LOG_LEVEL);
  const epubUploadLimitBytes = parseEpubUploadLimit(env.EPUB_UPLOAD_LIMIT_BYTES);
  const pdfUploadLimitBytes = parsePdfUploadLimit(env.PDF_UPLOAD_LIMIT_BYTES);
  const pdfTimeoutMs = resolveStructuredPdfTimeoutMs(env.PDF_TIMEOUT_MS);
  const pdfStructuredMemoryMib = resolveStructuredPdfMemoryMib(
    env.PDF_STRUCTURED_MEMORY_MIB,
    platform
  );

  return {
    databaseDir: env.DATABASE_DIR ?? defaultServerConfig.databaseDir,
    epubUploadLimitBytes,
    host: env.HOST ?? defaultServerConfig.host,
    imageResourcesDir: env.IMAGE_RESOURCES_DIR ?? defaultServerConfig.imageResourcesDir,
    logLevel,
    pdfOcrBinary: env.PDF_OCR_BINARY ?? defaultServerConfig.pdfOcrBinary,
    pdfTesseractBinary: env.PDF_TESSERACT_BINARY ?? defaultServerConfig.pdfTesseractBinary,
    pdfImportStageDir: env.PDF_IMPORT_STAGE_DIR ?? defaultServerConfig.pdfImportStageDir,
    pdfUploadLimitBytes,
    pdfPythonBinary: env.PDF_PYTHON_BINARY ?? defaultServerConfig.pdfPythonBinary,
    pdfTimeoutMs,
    pdfStructuredMemoryMib,
    pdfImportFixtureConversion:
      parseBooleanFlag(env.PDF_IMPORT_FIXTURE_CONVERSION) ??
      defaultServerConfig.pdfImportFixtureConversion,
    pdfImportFixtureOcr:
      parseBooleanFlag(env.PDF_IMPORT_FIXTURE_OCR) ?? defaultServerConfig.pdfImportFixtureOcr,
    port,
    sourceFilesDir: env.SOURCE_FILES_DIR ?? defaultServerConfig.sourceFilesDir,
    workCreationStageDir: env.WORK_CREATION_STAGE_DIR ?? defaultServerConfig.workCreationStageDir,
    webDir: env.WEB_DIR ?? defaultServerConfig.webDir
  };
}

export function createLoggerOptions(
  logLevel: ServerLogLevel
): NonNullable<FastifyServerOptions["logger"]> {
  return {
    level: logLevel,
    redact: ["req.headers.authorization", "req.headers.cookie"]
  };
}

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined) {
    return defaultServerConfig.port;
  }

  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return port;
}

function parseLogLevel(rawLogLevel: string | undefined): ServerLogLevel {
  if (rawLogLevel === undefined) {
    return defaultServerConfig.logLevel;
  }

  if (!serverLogLevels.has(rawLogLevel as ServerLogLevel)) {
    throw new Error("LOG_LEVEL must be a valid Pino log level.");
  }

  return rawLogLevel as ServerLogLevel;
}

function parseEpubUploadLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined) {
    return defaultServerConfig.epubUploadLimitBytes;
  }

  const limit = Number.parseInt(rawLimit, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("EPUB_UPLOAD_LIMIT_BYTES must be a positive integer number of bytes.");
  }

  return limit;
}

function parsePdfUploadLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined) {
    return defaultServerConfig.pdfUploadLimitBytes;
  }

  const limit = Number.parseInt(rawLimit, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("PDF_UPLOAD_LIMIT_BYTES must be a positive integer number of bytes.");
  }

  return limit;
}

// A permissive boolean env flag: `1`/`true`/`yes`/`on` (case-insensitive) enable it, anything else
// disables it, and an absent value returns undefined so the caller applies its default.
function parseBooleanFlag(rawFlag: string | undefined): boolean | undefined {
  if (rawFlag === undefined) {
    return undefined;
  }

  return ["1", "true", "yes", "on"].includes(rawFlag.trim().toLowerCase());
}
