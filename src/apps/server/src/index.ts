import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDbClient } from "./db/dbClient.js";
import { runMigrations } from "./db/migrate.js";
import { createSourceFileStore } from "./files/sourceFileStore.js";
import { createServer } from "./http/createServer.js";

const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);
const sourceFileStore = createSourceFileStore(config.sourceFilesDir);

const server = createServer({
  content: {
    createEntryId: () => randomUUID(),
    createSourceId: () => randomUUID(),
    db,
    sourceFileStore
  },
  library: {
    createAuthorId: () => randomUUID(),
    createEntryId: () => randomUUID(),
    db
  },
  logger: createLoggerOptions(config.logLevel)
});

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "server_started");
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
}
