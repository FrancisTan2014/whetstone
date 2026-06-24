import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDbClient } from "./db/dbClient.js";
import { runMigrations } from "./db/migrate.js";
import { createEpubParser } from "./files/epubSource.js";
import { createSourceFileStore } from "./files/sourceFileStore.js";
import { seedNoteTemplates } from "./features/notes/noteCommands.js";
import { createHttpClient } from "./lookup/httpClient.js";
import { createInMemoryLookupCache } from "./lookup/lookupCache.js";
import {
  createMerriamWebsterProvider,
  merriamWebsterAttributions
} from "./lookup/merriamWebsterProvider.js";
import { createFreeDictionaryProvider } from "./lookup/freeDictionaryProvider.js";
import { createLookupService, type LookupSource } from "./lookup/lookupService.js";
import { createServer } from "./http/createServer.js";

const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);
await seedNoteTemplates(db);
const sourceFileStore = createSourceFileStore(config.sourceFilesDir);
const epubParser = createEpubParser(join(config.sourceFilesDir, "epub-resources"));

const httpClient = createHttpClient();
// English lookup chain: Merriam-Webster Learner's, then Collegiate (each only when its key
// is set), then the no-key Free Dictionary fallback — so the feature works with no keys.
const lookupSources: LookupSource[] = [];

if (config.merriamWebsterLearnersKey !== undefined) {
  lookupSources.push({
    attribution: merriamWebsterAttributions.learners,
    provider: createMerriamWebsterProvider({
      apiKey: config.merriamWebsterLearnersKey,
      httpClient,
      reference: "learners"
    })
  });
}

if (config.merriamWebsterCollegiateKey !== undefined) {
  lookupSources.push({
    attribution: merriamWebsterAttributions.collegiate,
    provider: createMerriamWebsterProvider({
      apiKey: config.merriamWebsterCollegiateKey,
      httpClient,
      reference: "collegiate"
    })
  });
}

lookupSources.push({ provider: createFreeDictionaryProvider({ httpClient }) });

const lookupService = createLookupService({
  cache: createInMemoryLookupCache(),
  sources: lookupSources
});

const server = createServer({
  content: {
    createAuthorId: () => randomUUID(),
    createEntryId: () => randomUUID(),
    createSourceId: () => randomUUID(),
    db,
    epubParser,
    epubUploadLimitBytes: config.epubUploadLimitBytes,
    sourceFileStore
  },
  library: {
    createAuthorId: () => randomUUID(),
    createEntryId: () => randomUUID(),
    db
  },
  logger: createLoggerOptions(config.logLevel),
  lookup: { lookup: lookupService.lookup },
  notes: {
    createEntryId: () => randomUUID(),
    db
  }
});

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "server_started");
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
}
