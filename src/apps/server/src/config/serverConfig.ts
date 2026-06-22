import type { FastifyServerOptions } from "fastify";

export type ServerLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type ServerConfig = Readonly<{
  host: string;
  logLevel: ServerLogLevel;
  port: number;
}>;

const defaultServerConfig: ServerConfig = {
  host: "127.0.0.1",
  logLevel: "info",
  port: 3000
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

  return {
    host: env.HOST ?? defaultServerConfig.host,
    logLevel,
    port
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
