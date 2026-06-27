import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readServerConfig } from "../config/serverConfig.js";
import { createDbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import { createRecallMcpServer } from "./recallTools.js";

// Stdio entry point for the whetstone recall MCP server (#190). An MCP client (any local or cloud
// LLM coach) spawns this over stdio. It shares the same PGlite store as the HTTP server — point
// DATABASE_DIR at the same folder so the coach and the reader see the same recall set. Wiring only;
// all tool behavior lives in (and is tested through) recallTools.ts.
const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);

const server = createRecallMcpServer({
  currentUser: createDefaultCurrentUserProvider(),
  dueLimit: 20,
  now: () => new Date(),
  recall: { createId: () => randomUUID(), db }
});

await server.connect(new StdioServerTransport());
