import type { FastifyServerOptions } from "fastify";

export type ServerLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type ServerConfig = Readonly<{
  databaseDir: string | undefined;
  epubUploadLimitBytes: number;
  host: string;
  imageResourcesDir: string;
  logLevel: ServerLogLevel;
  pdfPythonBinary: string;
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
  pdfPythonBinary: "python",
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

  return {
    databaseDir: env.DATABASE_DIR ?? defaultServerConfig.databaseDir,
    epubUploadLimitBytes,
    host: env.HOST ?? defaultServerConfig.host,
    imageResourcesDir: env.IMAGE_RESOURCES_DIR ?? defaultServerConfig.imageResourcesDir,
    logLevel,
    pdfPythonBinary: env.PDF_PYTHON_BINARY ?? defaultServerConfig.pdfPythonBinary,
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
