import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";

import WordPOS from "wordpos";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readServerConfig } from "../config/serverConfig.js";
import { createDbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { expireCardCreationAttempts } from "../features/notesReview/cardCreationAttemptStore.js";
import { winkLemmatizer } from "../features/lexical/lexicalLemmatizer.js";
import { createLexicalRelationService } from "../features/lexical/lexicalRelationService.js";
import {
  createWordNetLexical,
  type WordPosSeekLike
} from "../features/lexical/wordnetLexicalProvider.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import { createMcpPreviewServer } from "./mcpServer.js";

// The local stdio MCP bootstrap for the card-preview surface (#717). Coverage-excluded, wiring-only: it opens
// the SAME local PostgreSQL (PGlite) database and offline WordNet the HTTP server uses, sweeps expired
// card-creation attempts on startup (so a preview never blocks on a lapsed one), builds the shared preview
// command, registers the single `preview_card_creation` tool, and serves it over stdio. All diagnostics go to
// stderr — stdout is reserved for the JSON-RPC transport frames.

// The 30-minute attempt window, matching the HTTP New-card review window (#712): a staged preview a learner
// never approves expires and is swept, so no attempt lingers and no scheduler is added.
const cardCreationAttemptTtlMs = 30 * 60 * 1000;

async function main(): Promise<void> {
  const config = readServerConfig();
  const pglite = new PGlite(config.databaseDir);
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  await expireCardCreationAttempts(db, new Date());

  const wordpos = new WordPOS();
  const lexical = createLexicalRelationService({
    wordnet: createWordNetLexical(wordpos as unknown as WordPosSeekLike),
    lemmatize: winkLemmatizer
  });

  const server = createMcpPreviewServer({
    preview: {
      attemptTtlMs: cardCreationAttemptTtlMs,
      createId: () => randomUUID(),
      db,
      lexical,
      now: () => new Date()
    },
    currentUser: createDefaultCurrentUserProvider(),
    log: (line) => {
      process.stderr.write(`${line}\n`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("whetstone card-preview MCP server ready on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`whetstone card-preview MCP server failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
