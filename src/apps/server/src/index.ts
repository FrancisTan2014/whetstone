import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDbClient } from "./db/dbClient.js";
import { runMigrations } from "./db/migrate.js";
import { createEpubParser } from "./files/epubSource.js";
import { createSourceFileStore } from "./files/sourceFileStore.js";
import { seedNoteTemplates } from "./features/notes/noteCommands.js";
import { cedictAttribution, createCedictProvider, parseCedict } from "./lookup/cedict.js";
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
    languages: ["en"],
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
    languages: ["en"],
    provider: createMerriamWebsterProvider({
      apiKey: config.merriamWebsterCollegiateKey,
      httpClient,
      reference: "collegiate"
    })
  });
}

lookupSources.push({ languages: ["en"], provider: createFreeDictionaryProvider({ httpClient }) });

// Chinese lookup: the bundled CC-CEDICT dataset, decompressed and parsed once at startup.
// Resolve via import.meta.url so it works from the built dist/index.js (the build copies
// src/lookup/data into dist/lookup/data).
const cedictPath = new URL("./lookup/data/cedict.u8.gz", import.meta.url);
const cedictText = gunzipSync(readFileSync(cedictPath)).toString("utf8");
lookupSources.push({
  attribution: cedictAttribution,
  languages: ["zh-CN", "zh-TW"],
  provider: createCedictProvider(parseCedict(cedictText))
});

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
