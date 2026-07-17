import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import WordPOS from "wordpos";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDbClient } from "./db/dbClient.js";
import { runMigrations } from "./db/migrate.js";
import { createEpubParser } from "./files/epubSource.js";
import { createImageResourceStore } from "./files/imageResourceStore.js";
import { composePdfToMarkdown, createDoclingPdfToMarkdown } from "./files/pdfToMarkdown.js";
import { createOcrmypdfPreprocess } from "./files/pdfOcr.js";
import { createSourceFileStore } from "./files/sourceFileStore.js";
import { createCedictProvider, parseCedict } from "./lookup/cedict.js";
import { createWiktionaryEntryLookup, createWordNetEntryLookup } from "./lookup/englishLookup.js";
import { createFreeDictionaryProvider } from "./lookup/freeDictionaryProvider.js";
import { createHttpClient } from "./lookup/httpClient.js";
import { createInMemoryLookupCache } from "./lookup/lookupCache.js";
import { createLookupService, type LookupSource } from "./lookup/lookupService.js";
import { createMoedictProvider } from "./lookup/moedictProvider.js";
import { createOfflineGloss } from "./lookup/offlineGloss.js";
import { createWordNetProvider, type WordPosLike } from "./lookup/wordnetProvider.js";
import { createZhWiktionaryProvider } from "./lookup/zhWiktionaryProvider.js";
import { readExplainConfig, resolveExplainer } from "./lookup/explainProvider.js";
import { createServer } from "./http/createServer.js";
import { createDefaultCurrentUserProvider } from "./identity/currentUser.js";
import { createOllamaModel, probeOllamaModel } from "./llm/llmModel.js";
import { readDiaryTidyConfig } from "./llm/aiUtilityConfig.js";
import { checkAiUtilityHealth } from "./llm/aiUtilityHealth.js";
import { resolveDiaryTidy } from "./features/diary/diaryTidy.js";
import {
  processNextVoiceCapture,
  requeueStalledVoiceCaptures,
  type VoiceCaptureWorkerDependencies
} from "./features/diary/voiceCaptureWorker.js";
import { createFakeSpeechInput } from "./speech/fakeSpeechInput.js";
import { readSpeechConfig, resolveSpeechInput } from "./speech/speechConfig.js";
import { checkSpeechHealth } from "./speech/speechHealth.js";
import { createWhisperSpeechInput } from "./speech/whisperSpeechInput.js";

const config = readServerConfig();
const pglite = new PGlite(config.databaseDir);
await runMigrations(pglite);
const db = createDbClient(pglite);
const sourceFileStore = createSourceFileStore(config.sourceFilesDir);
const epubParser = createEpubParser(
  join(config.sourceFilesDir, "epub-resources"),
  // Expected, recoverable ingestion events (e.g. a manifest resource whose bytes are missing, so the
  // image is skipped) — logged at debug at the ingestion boundary, matching the ingestionLogger below.
  (event, fields) => console.debug(`[epub] ${event}`, JSON.stringify(fields))
);
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

// Chinese lookup is Chinese-first (#272): 萌典 (moedict) serves Chinese definitions over its open JSON
// API (networked, time-boxed) as the primary tab, with the bundled CC-CEDICT (English glosses)
// decompressed and parsed once at startup as the offline secondary/fallback tab. Resolve the dataset
// via import.meta.url so it works from the built dist/index.js (the build copies src/lookup/data into
// dist/lookup/data).
const moedict = createMoedictProvider({ httpClient });
lookupSources.push({ id: "moedict", languages: ["zh-CN", "zh-TW"], lookup: moedict.lookup });

// zh.Wiktionary (#296): the networked Chinese Wiktionary over the MediaWiki action=parse API, a
// second Chinese tab with richer classical senses/古義/詞源 than 萌典. Time-boxed; a fetch failure
// surfaces as that tab's error (its lookup throws), never emptying the panel (#196/#306).
const zhWiktionary = createZhWiktionaryProvider({ httpClient });
lookupSources.push({
  id: "zhwiktionary",
  languages: ["zh-CN", "zh-TW"],
  lookup: zhWiktionary.lookup
});

const cedictPath = new URL("./lookup/data/cedict.u8.gz", import.meta.url);
const cedictText = gunzipSync(readFileSync(cedictPath)).toString("utf8");
const cedict = createCedictProvider(parseCedict(cedictText));
lookupSources.push({ id: "cedict", languages: ["zh-CN", "zh-TW"], lookup: cedict.lookup });

// The optional local-LLM "AI 解释" contextual aid for Chinese (#341): a labeled, view-only explanation
// of the selected span in its sentence, served by the local Ollama model named in EXPLAIN_MODEL. Absent
// config resolves to an "unavailable" provider (the tab shows its honest empty state), so no model is
// required for the deploy or the gate. It shares the one `LlmModel` seam (#385) — the same time-boxed
// local adapter diary tidy uses — so an unreachable daemon can never hang the tab.
const explainConfig = readExplainConfig();
const explain = resolveExplainer({
  config: explainConfig,
  createModel: createOllamaModel
});
lookupSources.push({
  id: "llm",
  languages: ["zh-CN", "zh-TW"],
  lookup: (term, options) => explain({ context: options.context, language: options.language, term })
});

const lookupService = createLookupService({
  cache: createInMemoryLookupCache(),
  sources: lookupSources
});

// Offline gloss autofill (#526): compose a `resolveOfflineGloss` from the offline dictionaries already
// built above — WordNet for English, CC-CEDICT for Chinese (chosen by script). Offline-only by
// construction (no networked/LLM source is wired here), so enrolling a `word`/`phrase` with no back
// never blocks capture on the network. Threaded into the recall and Make Durable enroll feeders below.
const resolveOfflineGloss = createOfflineGloss({
  english: (term) => wordNetLookup(term),
  chinese: (term) => cedict.lookup(term)
});

// The speech input seam (#207): config-gated and absent-config-safe. With no Whisper, speech stays on
// its fake; configured (WHISPER_BINARY + WHISPER_MODEL_PATH), the real local adapter transcribes voice
// diary captures (#236).
const speechConfig = readSpeechConfig();
const speech = resolveSpeechInput({
  config: speechConfig,
  createWhisper: (config) => createWhisperSpeechInput({ config }),
  fake: createFakeSpeechInput({ transcript: "", words: [] })
});

// Durable store for recorded Tap-and-Talk clips (#565): an async voice capture must survive a restart
// until the worker transcribes it, so its audio is written under the server-owned sources dir.
const voiceCaptureAudioDir = join(config.sourceFilesDir, "voice-captures");
mkdirSync(voiceCaptureAudioDir, { recursive: true });
const saveVoiceCaptureAudio = (audio: Buffer): Promise<string> => {
  const path = join(voiceCaptureAudioDir, `${randomUUID()}.audio`);
  writeFileSync(path, audio);
  return Promise.resolve(path);
};

const server = createServer({
  authoredWorks: {
    createEntryId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  content: {
    createAuthorId: () => randomUUID(),
    createEntryId: () => randomUUID(),
    createSourceId: () => randomUUID(),
    db,
    epubParser,
    epubUploadLimitBytes: config.epubUploadLimitBytes,
    imageResourceStore,
    // Fail-loud (#311): record each unrecognized block-level element to stderr as a structured line
    // so an unmodelled publisher construct is visible in logs rather than silently dropped.
    ingestionLogger: (records) => {
      for (const record of records) {
        console.warn("[ingestion] unrecognized block element", JSON.stringify(record));
      }
    },
    pdfToMarkdown: composePdfToMarkdown(
      createOcrmypdfPreprocess({
        ocrmypdfBinary: config.pdfOcrBinary,
        timeoutMs: config.pdfTimeoutMs
      }),
      createDoclingPdfToMarkdown({
        pythonBinary: config.pdfPythonBinary,
        scriptPath: fileURLToPath(new URL("./files/pdf_to_markdown.py", import.meta.url)),
        timeoutMs: config.pdfTimeoutMs
      })
    ),
    sourceFileStore
  },
  currentUser: createDefaultCurrentUserProvider(),
  // A diary capture journals only (#571): it saves the Entry immediately with no tidy or proposal step in
  // the path. The async Tap-and-Talk voice worker (below) owns the tidy pass. Local + private, like v0.
  diary: {
    createId: () => randomUUID(),
    db,
    now: () => new Date(),
    saveAudio: saveVoiceCaptureAudio
  },
  images: { imageResourceStore },
  library: {
    createAuthorId: () => randomUUID(),
    createEntryId: () => randomUUID(),
    db,
    deleteSourceFile: (relativePath) => sourceFileStore.deleteSourceFile(relativePath),
    // A retained source file that could not be unlinked on work delete (#541) is logged as one
    // structured warn — the DB delete has already committed, so this never fails the request.
    logSourceUnlinkFailure: ({ error, filePath }) =>
      console.warn(
        "[library] failed to unlink work source file on delete",
        JSON.stringify({ filePath, reason: error instanceof Error ? error.message : String(error) })
      )
  },
  logger: createLoggerOptions(config.logLevel),
  lookup: { lookup: lookupService.lookup },
  notes: {
    createEntryId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  notesReview: {
    createId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  readingPosition: { db },
  preferences: { db },
  recall: {
    createId: () => randomUUID(),
    db,
    now: () => new Date(),
    resolveOfflineGloss
  },
  recitation: {
    createEntryId: () => randomUUID(),
    createId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  search: { db },
  today: { db, now: () => new Date() },
  // In a single-origin deploy (#184) the built web client is served from this same server; in
  // dev/tests WEB_DIR is unset and Vite serves the client separately.
  web: config.webDir !== undefined ? { dir: config.webDir } : undefined
});

// The async Tap-and-Talk worker (#565): one in-process background loop that drains queued voice captures
// one at a time (transcribe → tidy → ready). The diary "tidy" pass is an optional local AI utility now
// decoupled from the coach (#602): it uses the model named in DIARY_TIDY_MODEL (or the COACH_MODEL
// alias) through the shared `LlmModel` seam. With no model configured it resolves to an identity tidier,
// so a capture is persisted verbatim (faithful, never faked) with no Ollama call.
const diaryTidyConfig = readDiaryTidyConfig();
const voiceCaptureWorker: VoiceCaptureWorkerDependencies = {
  db,
  speech,
  tidy: resolveDiaryTidy({ config: diaryTidyConfig, createModel: createOllamaModel })
};
const VOICE_CAPTURE_POLL_MS = 1_000;
let voiceCaptureDraining = false;
// Drain the queue to empty on each tick, but never run two drains at once (one capture at a time), so a
// slow STT/model does not overlap ticks. Failures are logged; the loop continues on the next tick.
const drainVoiceCaptureQueue = async (): Promise<void> => {
  if (voiceCaptureDraining) {
    return;
  }
  voiceCaptureDraining = true;
  try {
    let result = await processNextVoiceCapture(voiceCaptureWorker);
    while (result.status !== "idle") {
      result = await processNextVoiceCapture(voiceCaptureWorker);
    }
  } catch (error) {
    server.log.error({ err: error }, "voice_capture_worker_failed");
  } finally {
    voiceCaptureDraining = false;
  }
};

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "server_started");

  // Recover any voice captures a previous process left mid-flight (transcribing/tidying), then start the
  // background drain loop so queued clips are processed without the user waiting.
  const requeued = await requeueStalledVoiceCaptures(db);
  if (requeued > 0) {
    server.log.info({ requeued }, "voice_capture_requeued_stalled");
  }
  setInterval(() => {
    void drainVoiceCaptureQueue();
  }, VOICE_CAPTURE_POLL_MS).unref();

  // Report the optional AI utilities' model wiring (#602): diary "tidy" and the Reader "AI 解释" gloss.
  // A clean "run pnpm setup:ai" hint when a utility is off or its Ollama model is not serving, instead
  // of a silent degrade (an un-tidied entry / an "unavailable" gloss tab). Neither blocks startup.
  for (const utility of [
    { label: "Diary tidy", modelName: diaryTidyConfig.modelName },
    { label: "AI 解释", modelName: explainConfig.modelName }
  ]) {
    const utilityHealth = await checkAiUtilityHealth({
      label: utility.label,
      modelName: utility.modelName,
      probeModel: probeOllamaModel,
      setupHint: "pnpm setup:ai"
    });
    if (utilityHealth.status === "unavailable") {
      server.log.warn({ aiUtility: utilityHealth.status }, utilityHealth.message);
    } else {
      server.log.info({ aiUtility: utilityHealth.status }, utilityHealth.message);
    }
  }

  // Report the Whisper STT wiring (#347): a clear "run pnpm setup:voice" hint when voice diary capture
  // would otherwise silently transcribe to empty, instead of an unexplained empty transcript.
  const speechHealth = checkSpeechHealth({ config: speechConfig });
  if (speechHealth.status === "fake") {
    server.log.warn({ speech: speechHealth.status }, speechHealth.message);
  } else {
    server.log.info({ speech: speechHealth.status }, speechHealth.message);
  }
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
}
