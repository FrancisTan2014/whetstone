import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import WordPOS from "wordpos";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDbClient } from "./db/dbClient.js";
import { runMigrations } from "./db/migrate.js";
import { createEpubParser } from "./files/epubSource.js";
import { createImageResourceStore } from "./files/imageResourceStore.js";
import { createDoclingPdfToMarkdown } from "./files/pdfToMarkdown.js";
import { createSourceFileStore } from "./files/sourceFileStore.js";
import { seedCaseCorpus } from "./features/cases/caseSeed.js";
import { seedNoteTemplates } from "./features/notes/noteCommands.js";
import { createCedictProvider, parseCedict } from "./lookup/cedict.js";
import { createWiktionaryEntryLookup, createWordNetEntryLookup } from "./lookup/englishLookup.js";
import { createFreeDictionaryProvider } from "./lookup/freeDictionaryProvider.js";
import { createHttpClient } from "./lookup/httpClient.js";
import { createInMemoryLookupCache } from "./lookup/lookupCache.js";
import { createLookupService, type LookupSource } from "./lookup/lookupService.js";
import { createWordNetProvider, type WordPosLike } from "./lookup/wordnetProvider.js";
import { createServer } from "./http/createServer.js";
import { createDefaultCurrentUserProvider } from "./identity/currentUser.js";
import { createFakeCoach } from "./coach/fakeCoach.js";
import { readCoachConfig, resolveCoach } from "./coach/coachConfig.js";
import { createFakeSpeechInput } from "./speech/fakeSpeechInput.js";
import { readSpeechConfig, resolveSpeechInput } from "./speech/speechConfig.js";
import { createWhisperSpeechInput } from "./speech/whisperSpeechInput.js";

const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);
await seedNoteTemplates(db);
await seedCaseCorpus(db);
const sourceFileStore = createSourceFileStore(config.sourceFilesDir);
const epubParser = createEpubParser(join(config.sourceFilesDir, "epub-resources"));
const imageResourceStore = createImageResourceStore(config.imageResourcesDir);

const httpClient = createHttpClient();
// English lookup exposes two independent sources (tabs): the offline, bundled WordNet (instant,
// always up) and the networked Wiktionary via the Free Dictionary API (rich, time-boxed). Neither
// blocks the other, so a slow/down Wiktionary host never freezes the offline WordNet tab (#196).
const wiktionaryLookup = createWiktionaryEntryLookup(createFreeDictionaryProvider({ httpClient }));
const wordNetLookup = createWordNetEntryLookup(
  createWordNetProvider(new WordPOS() as unknown as WordPosLike)
);

const lookupSources: LookupSource[] = [
  { id: "wordnet", languages: ["en"], lookup: wordNetLookup },
  { id: "wiktionary", languages: ["en"], lookup: wiktionaryLookup }
];

// Chinese lookup: the bundled CC-CEDICT dataset, decompressed and parsed once at startup.
// Resolve via import.meta.url so it works from the built dist/index.js (the build copies
// src/lookup/data into dist/lookup/data).
const cedictPath = new URL("./lookup/data/cedict.u8.gz", import.meta.url);
const cedictText = gunzipSync(readFileSync(cedictPath)).toString("utf8");
const cedict = createCedictProvider(parseCedict(cedictText));
lookupSources.push({ id: "cedict", languages: ["zh-CN", "zh-TW"], lookup: cedict.lookup });

const lookupService = createLookupService({
  cache: createInMemoryLookupCache(),
  sources: lookupSources
});

// The coach (#206) and speech (#207) seams: config-gated and absent-config-safe, so with no API key
// and no Whisper they stay on the deterministic fakes (the keyless dev/practice path). When Whisper is
// configured (WHISPER_BINARY + WHISPER_MODEL_PATH), the real local adapter transcribes spoken turns (#236).
const coach = resolveCoach({ config: readCoachConfig(), fake: createFakeCoach() });
const speech = resolveSpeechInput({
  config: readSpeechConfig(),
  createWhisper: (config) => createWhisperSpeechInput({ config }),
  fake: createFakeSpeechInput({ transcript: "", words: [] })
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
    pdfToMarkdown: createDoclingPdfToMarkdown({
      pythonBinary: config.pdfPythonBinary,
      scriptPath: fileURLToPath(new URL("./files/pdf_to_markdown.py", import.meta.url))
    }),
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
  map: { db, now: () => new Date() },
  notes: {
    createEntryId: () => randomUUID(),
    db
  },
  readingPosition: { db },
  search: { db },
  session: {
    coach,
    createId: () => randomUUID(),
    db,
    now: () => new Date(),
    saveAudio: (audio) => {
      const path = join(tmpdir(), `whetstone-${randomUUID()}.audio`);
      writeFileSync(path, audio);
      return Promise.resolve(path);
    },
    speech
  },
  // In a single-origin deploy (#184) the built web client is served from this same server; in
  // dev/tests WEB_DIR is unset and Vite serves the client separately.
  web: config.webDir !== undefined ? { dir: config.webDir } : undefined
});

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "server_started");
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
}
