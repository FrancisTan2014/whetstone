import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { PGlite } from "@electric-sql/pglite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WordPOS from "wordpos";

import { readServerConfig } from "../config/serverConfig.js";
import { createDbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import { createCedictProvider, parseCedict } from "../lookup/cedict.js";
import { createWordNetEntryLookup } from "../lookup/englishLookup.js";
import { createOfflineGloss } from "../lookup/offlineGloss.js";
import { createWordNetProvider, type WordPosLike } from "../lookup/wordnetProvider.js";
import { createRecallMcpServer } from "./recallTools.js";

// Stdio entry point for the whetstone memory MCP server (#190/#595). An MCP client (any local or cloud
// LLM coach) spawns this over stdio. It shares the same PGlite store as the HTTP server — point
// DATABASE_DIR at the same folder so the coach and the reader see the same Memory set. Wiring only;
// all tool behavior lives in (and is tested through) recallTools.ts.
const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);

// Offline gloss autofill (#526): this process deposits Memory prompts via deposit_memory, so a
// pushed English target can still get a suggested answer. Compose the same offline glosser the HTTP
// server uses — WordNet (English) + CC-CEDICT (Chinese), chosen by script — from the bundled data
// (the build copies src/lookup/data into dist/lookup/data). Offline-only: no network at deposit.
const wordNetLookup = createWordNetEntryLookup(
  createWordNetProvider(new WordPOS() as unknown as WordPosLike)
);
const cedictPath = new URL("../lookup/data/cedict.u8.gz", import.meta.url);
const cedict = createCedictProvider(
  parseCedict(gunzipSync(readFileSync(cedictPath)).toString("utf8"))
);
const resolveOfflineGloss = createOfflineGloss({
  english: (term) => wordNetLookup(term),
  chinese: (term) => cedict.lookup(term)
});

const server = createRecallMcpServer({
  currentUser: createDefaultCurrentUserProvider(),
  dueLimit: 20,
  now: () => new Date(),
  memory: { createId: () => randomUUID(), db, resolveOfflineGloss }
});

await server.connect(new StdioServerTransport());
