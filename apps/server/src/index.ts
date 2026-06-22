import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createServer } from "./http/createServer.js";

const config = readServerConfig();
const server = createServer({ logger: createLoggerOptions(config.logLevel) });

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "server_started");
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
}
