import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import WordPOS from "wordpos";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDbClient } from "./db/dbClient.js";
import { runMigrations } from "./db/migrate.js";
import { createEpubParser } from "./files/epubSource.js";
import { createImageResourceStore } from "./files/imageResourceStore.js";
import { createSourceFileStore } from "./files/sourceFileStore.js";
import { seedNoteTemplates } from "./features/notes/noteCommands.js";
import { createCedictProvider, parseCedict } from "./lookup/cedict.js";
import { createEnglishLookup } from "./lookup/englishLookup.js";
import { createFreeDictionaryProvider } from "./lookup/freeDictionaryProvider.js";
import { createHttpClient } from "./lookup/httpClient.js";
import { createInMemoryLookupCache } from "./lookup/lookupCache.js";
import { createLookupService, type LookupSource } from "./lookup/lookupService.js";
import { createWordNetProvider, type WordPosLike } from "./lookup/wordnetProvider.js";
import { createServer } from "./http/createServer.js";
import { createDefaultCurrentUserProvider } from "./identity/currentUser.js";

const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);
await seedNoteTemplates(db);
const sourceFileStore = createSourceFileStore(config.sourceFilesDir);
const epubParser = createEpubParser(join(config.sourceFilesDir, "epub-resources"));
const imageResourceStore = createImageResourceStore(config.imageResourcesDir);

const httpClient = createHttpClient();
// English lookup composes the community Free Dictionary (Wiktionary) with the offline,
// bundled WordNet so it works monolingually with no keys and stays up even when the
// Wiktionary host is down.
const english = createEnglishLookup({
  wiktionary: createFreeDictionaryProvider({ httpClient }),
  wordNet: createWordNetProvider(new WordPOS() as unknown as WordPosLike)
});

const lookupSources: LookupSource[] = [{ languages: ["en"], lookup: english.lookup }];

// Chinese lookup: the bundled CC-CEDICT dataset, decompressed and parsed once at startup.
// Resolve via import.meta.url so it works from the built dist/index.js (the build copies
// src/lookup/data into dist/lookup/data).
const cedictPath = new URL("./lookup/data/cedict.u8.gz", import.meta.url);
const cedictText = gunzipSync(readFileSync(cedictPath)).toString("utf8");
const cedict = createCedictProvider(parseCedict(cedictText));
lookupSources.push({ languages: ["zh-CN", "zh-TW"], lookup: cedict.lookup });

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
    imageResourceStore,
    sourceFileStore
  },
  currentUser: createDefaultCurrentUserProvider(),
  images: { imageResourceStore },
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
  },
  readingPosition: { db }
});

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "server_started");
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
}
