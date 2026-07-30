import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";

import * as lockfile from "proper-lockfile";
import WordPOS from "wordpos";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readServerConfig } from "../config/serverConfig.js";
import { createDatabaseLeaseAcquirer } from "../db/databaseLease.js";
import { openManagedDatabase } from "../db/databaseLifecycle.js";
import { runMigrations } from "../db/migrate.js";
import { expireCardCreationAttempts } from "../features/notesReview/cardCreationAttemptStore.js";
import { winkLemmatizer } from "../features/lexical/lexicalLemmatizer.js";
import { createLexicalRelationService } from "../features/lexical/lexicalRelationService.js";
import {
  createWordNetLexical,
  type WordPosSeekLike
} from "../features/lexical/wordnetLexicalProvider.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import { createMcpCardServer } from "./mcpServer.js";

// The local stdio MCP bootstrap for the card surface (#717 preview, #718 commit). Coverage-excluded,
// wiring-only: it opens the SAME local PostgreSQL (PGlite) database and offline WordNet the HTTP server uses,
// sweeps expired card-creation attempts on startup (so a preview never blocks on a lapsed one), builds the
// shared preview/commit commands, registers the `preview_card_creation` and `commit_card_creation` tools, and
// serves them over stdio. All diagnostics go to stderr — stdout is reserved for the JSON-RPC transport frames.

// The 30-minute attempt window, matching the HTTP New-card review window (#712): a staged preview a learner
// never approves expires and is swept, so no attempt lingers and no scheduler is added.
const cardCreationAttemptTtlMs = 30 * 60 * 1000;

async function main(): Promise<void> {
  const config = readServerConfig();
  // The MCP surface opens the SAME persistent database as the HTTP server, so it takes the same
  // single-owner lease (#805): it cannot run while the app owns the directory, and a competing start
  // fails loudly before PGlite construction instead of racing a second runtime into one WAL.
  const managedDatabase = await openManagedDatabase({
    databaseDir: config.databaseDir,
    openPglite: async (databaseDir) => {
      const instance = new PGlite(databaseDir);
      await instance.waitReady;
      return instance;
    },
    acquireLease: createDatabaseLeaseAcquirer({
      lock: (file, options) => lockfile.lock(file, options),
      onCompromised: (error) => {
        process.stderr.write(`whetstone card MCP server lease compromised: ${String(error)}\n`);
        void managedDatabase.close().finally(() => process.exit(1));
      }
    })
  });
  const { pglite, db } = managedDatabase;
  try {
    await runMigrations(pglite);
    await expireCardCreationAttempts(db, new Date());
  } catch (error) {
    // Startup failure releases the lease so the directory stays reopenable.
    await managedDatabase.close();
    throw error;
  }

  const wordpos = new WordPOS();
  const lexical = createLexicalRelationService({
    wordnet: createWordNetLexical(wordpos as unknown as WordPosSeekLike),
    lemmatize: winkLemmatizer
  });

  const server = createMcpCardServer({
    preview: {
      attemptTtlMs: cardCreationAttemptTtlMs,
      createId: () => randomUUID(),
      db,
      lexical,
      now: () => new Date()
    },
    commit: {
      createId: () => randomUUID(),
      db,
      now: () => new Date()
    },
    currentUser: createDefaultCurrentUserProvider(),
    log: (line) => {
      process.stderr.write(`${line}\n`);
    }
  });

  // Release the lease on shutdown so the running app (or the next MCP invocation) can reclaim the
  // directory. Idempotent by construction of `managedDatabase.close`.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void managedDatabase.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("whetstone card MCP server ready on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`whetstone card MCP server failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
