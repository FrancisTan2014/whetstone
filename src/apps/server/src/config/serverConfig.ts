import type { FastifyServerOptions } from "fastify";

export type ServerLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type ServerConfig = Readonly<{
  databaseDir: string | undefined;
  epubUploadLimitBytes: number;
  host: string;
  imageResourcesDir: string;
  logLevel: ServerLogLevel;
  pdfOcrBinary: string;
  pdfImportStageDir: string;
  pdfPythonBinary: string;
  pdfTimeoutMs: number;
  port: number;
  sourceFilesDir: string;
  webDir: string | undefined;
}>;

const defaultServerConfig: ServerConfig = {
  databaseDir: undefined,
  epubUploadLimitBytes: 50 * 1024 * 1024,
  host: "127.0.0.1",
  imageResourcesDir: "./.data/images",
  logLevel: "info",
  pdfOcrBinary: "ocrmypdf",
  // Recoverable PDF import stages (#721): transient per-attempt staged bytes, SEPARATE from immutable
  // source provenance under sourceFilesDir, so they are never backed up and a cancelled/failed/expired
  // attempt's bytes are freed without touching provenance. Env-overridable.
  pdfImportStageDir: "./.data/pdf-import-stages",
  pdfPythonBinary: "python",
  // Docling's per-page layout + table analysis is slow; oversized/scanned books can run for many
  // minutes. Bound the spawn so a slow PDF is killed and rejected (422) instead of hanging the
  // ingest request. v0 targets born-digital, reasonably-sized PDFs (#403). Env-overridable.
  pdfTimeoutMs: 180_000,
  port: 3000,
  sourceFilesDir: "./.data/sources",
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

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env.PORT);
  const logLevel = parseLogLevel(env.LOG_LEVEL);
  const epubUploadLimitBytes = parseEpubUploadLimit(env.EPUB_UPLOAD_LIMIT_BYTES);
  const pdfTimeoutMs = parsePdfTimeout(env.PDF_TIMEOUT_MS);

  return {
    databaseDir: env.DATABASE_DIR ?? defaultServerConfig.databaseDir,
    epubUploadLimitBytes,
    host: env.HOST ?? defaultServerConfig.host,
    imageResourcesDir: env.IMAGE_RESOURCES_DIR ?? defaultServerConfig.imageResourcesDir,
    logLevel,
    pdfOcrBinary: env.PDF_OCR_BINARY ?? defaultServerConfig.pdfOcrBinary,
    pdfImportStageDir: env.PDF_IMPORT_STAGE_DIR ?? defaultServerConfig.pdfImportStageDir,
    pdfPythonBinary: env.PDF_PYTHON_BINARY ?? defaultServerConfig.pdfPythonBinary,
    pdfTimeoutMs,
    port,
    sourceFilesDir: env.SOURCE_FILES_DIR ?? defaultServerConfig.sourceFilesDir,
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

function parsePdfTimeout(rawTimeout: string | undefined): number {
  if (rawTimeout === undefined) {
    return defaultServerConfig.pdfTimeoutMs;
  }

  const timeout = Number.parseInt(rawTimeout, 10);

  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("PDF_TIMEOUT_MS must be a positive integer number of milliseconds.");
  }

  return timeout;
}
