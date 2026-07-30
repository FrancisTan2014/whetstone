import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import * as lockfile from "proper-lockfile";
import WordPOS from "wordpos";

import { readServerConfig, createLoggerOptions } from "./config/serverConfig.js";
import { createDatabaseLeaseAcquirer } from "./db/databaseLease.js";
import { openManagedDatabase } from "./db/databaseLifecycle.js";
import { runMigrations } from "./db/migrate.js";
import { createEpubParser } from "./files/epubSource.js";
import { createImageResourceStore } from "./files/imageResourceStore.js";
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
import { createLexicalRelationService } from "./features/lexical/lexicalRelationService.js";
import { winkLemmatizer } from "./features/lexical/lexicalLemmatizer.js";
import {
  createWordNetLexical,
  type WordPosSeekLike
} from "./features/lexical/wordnetLexicalProvider.js";
import { createZhWiktionaryProvider } from "./lookup/zhWiktionaryProvider.js";
import { readExplainConfig, resolveExplainer } from "./lookup/explainProvider.js";
import { createServer } from "./http/createServer.js";
import type { ContentDependencies } from "./features/content/contentCommands.js";
import { createDefaultCurrentUserProvider } from "./identity/currentUser.js";
import { createOllamaModel, probeOllamaModel } from "./llm/llmModel.js";
import { readDiaryTidyConfig } from "./llm/aiUtilityConfig.js";
import { checkAiUtilityHealth } from "./llm/aiUtilityHealth.js";
import { resolveDiaryTidy } from "./features/diary/diaryTidy.js";
import { createVoiceCaptureAudioStore } from "./features/diary/voiceCaptureAudioStore.js";
import { backfillNoteMaterialFingerprints } from "./features/notes/noteMaterialFingerprintBackfill.js";
import { backfillNoteNearMatchKeys } from "./features/notes/noteNearMatchBackfill.js";
import { expireCardCreationAttempts } from "./features/notesReview/cardCreationAttemptStore.js";
import {
  processNextVoiceCapture,
  requeueStalledVoiceCaptures,
  type VoiceCaptureWorkerDependencies
} from "./features/diary/voiceCaptureWorker.js";
import {
  createPdfImportActiveRuns,
  processNextPdfImport,
  type PdfImportRunnerDependencies
} from "./features/pdfImport/pdfImportRunner.js";
import { createPdfImportStageStore } from "./features/pdfImport/pdfImportStage.js";
import {
  cancelPdfImport,
  type PdfImportCommandDependencies
} from "./features/pdfImport/pdfImportCommands.js";
import {
  loadPdfReviewSource,
  publishConvertedPdfImport,
  type PdfImportPublishDependencies
} from "./features/pdfImport/pdfImportPublish.js";
import { recoverInterruptedAttempts } from "./features/pdfImport/pdfImportStore.js";
import {
  beginPdfReview,
  type PdfReviewPort,
  type WorkCreationDependencies
} from "./features/workCreation/workCreationCommands.js";
import { resolveStructuredPdfRunner } from "./files/pdfStructuredRunnerResolution.js";
import { resolvePdfOcrAdapter } from "./files/pdfOcrRunnerResolution.js";
import { createFakeSpeechInput } from "./speech/fakeSpeechInput.js";
import { createLocalSpeechInput } from "./speech/localSpeechInput.js";
import { readSpeechConfig, resolveSpeechInput } from "./speech/speechConfig.js";
import { checkSpeechHealth } from "./speech/speechHealth.js";
import { createWhisperSpeechInput } from "./speech/whisperSpeechInput.js";

const config = readServerConfig();

// The single-owner database lifecycle boundary (#805). A persistent DATABASE_DIR is owned through a
// cross-process lease acquired BEFORE PGlite is constructed and released only after it is closed, so
// starting Whetstone twice — or a development watch reload — can never run two embedded PostgreSQL
// runtimes over one WAL. In-memory (DATABASE_DIR unset) needs no lease. Shutdown is wired below and
// referenced here so a compromised lease can trigger the same idempotent teardown.
let shuttingDown = false;
let httpServerListening = false;
const backgroundIntervals: NodeJS.Timeout[] = [];
// Assigned once the server exists; until then a compromise only records a failing exit code.
let performShutdown: (exitCode: number) => Promise<void> = (exitCode) => {
  process.exitCode = exitCode;
  return Promise.resolve();
};
const requestShutdown = (exitCode: number): void => {
  void performShutdown(exitCode);
};

const managedDatabase = await openManagedDatabase({
  databaseDir: config.databaseDir,
  openPglite: async (databaseDir) => {
    const instance = new PGlite(databaseDir);
    await instance.waitReady;
    return instance;
  },
  acquireLease: createDatabaseLeaseAcquirer({
    lock: (file, options) => lockfile.lock(file, options),
    // Losing the exclusive lease mid-run is fatal: another process may reclaim the directory, so stop
    // this one rather than keep writing into a store we no longer own.
    onCompromised: (error) => {
      console.error("[database] lease compromised; shutting down", error);
      requestShutdown(1);
    },
    // A development watch reload kills the old process and starts a replacement; a small bounded retry
    // lets the new process wait for the exiting owner's graceful release instead of failing the reload,
    // while a genuinely live competing owner (which keeps its heartbeat) still fails with a clear remedy.
    retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100 }
  })
});
const pglite = managedDatabase.pglite;
try {
  await runMigrations(pglite);
} catch (error) {
  // Startup failure performs the same cleanup: close PGlite and release the lease so the directory is
  // reopenable and the next start is not blocked by this failed attempt.
  await managedDatabase.close();
  throw error;
}
const db = managedDatabase.db;
// One-time backfill of exact-material fingerprints for legacy notes (#711). Composes the
// document-package projection after the pure-SQL migration, then VALIDATEs the shape constraint. It is
// idempotent (only NULL note rows), so a restart re-runs it harmlessly.
await backfillNoteMaterialFingerprints(db);
// One-time backfill of near-match keys for legacy notes (#713). Composes the same document-package
// projection as the write boundary; eligible notes get their relaxed key + length, unsupported notes stay
// null. Idempotent — a filled note is skipped next time — so a restart re-runs it harmlessly.
await backfillNoteNearMatchKeys(db);
// A parked New-card material-review attempt (#712) holds one pending review per (owner, submission) until
// the learner chooses Use existing material or Keep separate. An untouched attempt expires after this window
// and is swept at startup and after each attempt operation, so a forgotten review never lingers; no
// scheduler is added. Thirty minutes matches the Work-creation review window — generous for a human decision.
const cardCreationAttemptTtlMs = 30 * 60 * 1000;
// Sweep any material-review attempts left expired across a restart (#712), so a crash mid-review never
// strands a pending slot. Idempotent and cheap (a single delete of `expires_at <= now`).
await expireCardCreationAttempts(db, new Date());
const sourceFileStore = createSourceFileStore(config.sourceFilesDir);
// A parked Markdown creation-review attempt (#747) holds a single owner slot with staged bytes until the
// learner decides. After this window an untouched attempt is swept to `expired` and its stage cleaned, so a
// forgotten review never blocks the next import. Thirty minutes is generous for a human decision.
const workCreationAttemptTtlMs = 30 * 60 * 1000;
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
const wordpos = new WordPOS();
const wordNetLookup = createWordNetEntryLookup(
  createWordNetProvider(wordpos as unknown as WordPosLike)
);

// The offline typed lexical-relationship service (#715) reuses the same bundled WordNet instance behind its
// own seam (it additionally reads `seek`/pointers), so "Find related material" during New-card creation
// (#716) resolves fully offline with no extra database load.
const lexicalRelationService = createLexicalRelationService({
  wordnet: createWordNetLexical(wordpos as unknown as WordPosSeekLike),
  lemmatize: winkLemmatizer
});

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
// construction (no networked/LLM source is wired here), so filling a blank Note from a gloss with no
// back never blocks capture on the network. Threaded into the Notes-owned suggest route below (#662).
const resolveOfflineGloss = createOfflineGloss({
  english: (term) => wordNetLookup(term),
  chinese: (term) => cedict.lookup(term)
});

// The speech input seam (#207, #799): config-gated and absent-config-safe. With no provider configured,
// speech stays on its fake; configured (LOCAL_ASR_BINARY + LOCAL_ASR_MODEL, or the legacy WHISPER_* pair),
// the real local adapter transcribes voice diary captures (#236). A partial LOCAL_ASR_* pair is an
// explicit misconfiguration, not a silent fake fallback, so boot fails fast with the exact remedy.
const speechConfigResult = readSpeechConfig();
if (!speechConfigResult.ok) {
  throw new Error(`${speechConfigResult.error.message} ${speechConfigResult.error.remedy}`);
}
const speechConfig = speechConfigResult.config;
// The deterministic headless fake (no model, no mic) the gate and CI run on. Off, it transcribes to empty
// so a submitted clip fails as `voice_setup_required` (the honest "speech not set up" path). Under the
// env-gated E2E flag (VOICE_CAPTURE_FIXTURE_TRANSCRIPT=1) it becomes a function of the audio: a real WAV
// clip (RIFF…WAVE) yields a fixed English transcript so the browser suite can produce a READY voice entry
// to audit against its retained recording (#801), while any non-WAV bytes still transcribe to empty — so
// the failure spec's garbage clip stays `voice_setup_required`. Never enabled in production.
const voiceCaptureFixtureTranscript = process.env.VOICE_CAPTURE_FIXTURE_TRANSCRIPT === "1";
const isWavClip = (path: string): boolean => {
  try {
    const header = readFileSync(path);
    return (
      header.length >= 12 &&
      header.toString("ascii", 0, 4) === "RIFF" &&
      header.toString("ascii", 8, 12) === "WAVE"
    );
  } catch {
    return false;
  }
};
const fakeSpeech = voiceCaptureFixtureTranscript
  ? createFakeSpeechInput((audio) =>
      isWavClip(audio.path)
        ? { language: "en", transcript: "This is my recorded diary note for today.", words: [] }
        : { transcript: "", words: [] }
    )
  : createFakeSpeechInput({ transcript: "", words: [] });
const speech = resolveSpeechInput({
  config: speechConfig,
  createLocal: (config) => createLocalSpeechInput({ config }),
  createWhisper: (config) => createWhisperSpeechInput({ config }),
  fake: fakeSpeech
});

// Durable store for recorded Tap-and-Talk clips (#565): an async voice capture must survive a restart
// until the worker transcribes it, so its audio is written under the server-owned sources dir.
const voiceCaptureAudioDir = join(config.sourceFilesDir, "voice-captures");
mkdirSync(voiceCaptureAudioDir, { recursive: true });
// The read side of that store (#801): stream a retained recording back to the owned-entry audio endpoint
// with range support, resolved within this same root so a stored path can never escape it.
const voiceCaptureAudioStore = createVoiceCaptureAudioStore(voiceCaptureAudioDir);
const saveVoiceCaptureAudio = (audio: Buffer): Promise<string> => {
  const path = join(voiceCaptureAudioDir, `${randomUUID()}.audio`);
  writeFileSync(path, audio);
  return Promise.resolve(path);
};
// Best-effort removal of a discarded failed capture's clip (#675): the DB rows are already gone, so a
// missing/already-unlinked file is not an error — a stale file just lingers, logged at warn.
const deleteVoiceCaptureAudio = (path: string): Promise<void> => {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.warn(
      "[diary] failed to unlink removed voice capture audio",
      JSON.stringify({ path, reason: error instanceof Error ? error.message : String(error) })
    );
  }
  return Promise.resolve();
};

// #721/#702 shared PDF import primitives, created before the server so its born-digital import routes and
// its background conversion worker share one stage store + active-run registry. `logCleanupFailure` reads
// `server.log` lazily (only at request time, after the server below exists).
const pdfImportStageStore = createPdfImportStageStore(config.pdfImportStageDir);
const pdfImportActiveRuns = createPdfImportActiveRuns();
const logPdfImportCleanupFailure = ({
  attemptId,
  stagePath,
  reason
}: Readonly<{ attemptId: string; stagePath: string; reason: string }>): void =>
  server.log.warn({ attemptId, stagePath, reason }, "pdf_import_stage_cleanup_failed");
const pdfImportCommands: PdfImportCommandDependencies = {
  activeRuns: pdfImportActiveRuns,
  createAttemptId: () => randomUUID(),
  db,
  logCleanupFailure: logPdfImportCleanupFailure,
  now: () => new Date(),
  stageStore: pdfImportStageStore
};

const contentDependencies = {
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
  sourceFileStore
} satisfies ContentDependencies;

// #702 publishes a converted attempt into a canonical Work (doc_blocks only). Since #750 this happens ONLY
// through a serialized Work-creation review decision (never the drain loop), so the deps are built here —
// before the server — and shared by the review bridge's PDF port below.
const pdfImportPublish: PdfImportPublishDependencies = {
  createAuthorId: () => randomUUID(),
  createEntryId: () => randomUUID(),
  createSourceId: () => randomUUID(),
  db,
  // Publication retains the original uploaded PDF through the immutable source-file boundary, reading it
  // back from the attempt's retained stage; a failed cleanup of that redundant stage stays visible.
  logCleanupFailure: logPdfImportCleanupFailure,
  now: () => new Date(),
  sourceFileStore,
  stageStore: pdfImportStageStore
};

// The PDF-import bridge port (#750) the Work-creation review boundary uses to route a converted PDF through
// the SAME duplicate review without importing pdfImport internals: read a converted attempt's resolved
// metadata, publish it as a Work (create or exact-reopen) under a decision, or discard it when the review
// reopened an existing Work instead. `publish` narrows the publication result to the entry id + reopen flag
// the review needs; a non-`published` status is an idempotency/refusal guard the decision only sees under an
// untestable concurrent race.
const pdfReviewPort: PdfReviewPort = {
  loadForReview: (attemptId) => loadPdfReviewSource(pdfImportPublish, attemptId),
  publish: async (attemptId) => {
    const outcome = await publishConvertedPdfImport(pdfImportPublish, attemptId);
    return outcome.status === "published"
      ? { status: "published", workEntryId: outcome.work.entryId, reopened: outcome.reopened }
      : { status: outcome.status };
  },
  discard: async (attemptId, userId) => {
    await cancelPdfImport(pdfImportCommands, { attemptId, userId });
  }
};

// The Work-creation review boundary (#747-#750), shared by the review routes and the PDF status bridge.
const workCreationDependencies: WorkCreationDependencies = {
  content: contentDependencies,
  createAttemptId: () => randomUUID(),
  createStageId: () => randomUUID(),
  now: () => new Date(),
  attemptTtlMs: workCreationAttemptTtlMs,
  // A structural logger for how many credible duplicate candidates the boundary weighed, mirroring the
  // library duplicate-candidate query's log shape without depending on Fastify.
  log: {
    info: (payload, message) => console.info(`[work-creation] ${message}`, JSON.stringify(payload))
  },
  pdf: pdfReviewPort
};

const server = createServer({
  authoredWorks: {
    createEntryId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  content: contentDependencies,
  currentUser: createDefaultCurrentUserProvider(),
  // A diary capture journals only (#571): it saves the Entry immediately with no tidy or proposal step in
  // the path. The async Tap-and-Talk voice worker (below) owns the tidy pass. Local + private, like v0.
  diary: {
    audioStore: voiceCaptureAudioStore,
    createId: () => randomUUID(),
    db,
    deleteAudio: deleteVoiceCaptureAudio,
    now: () => new Date(),
    saveAudio: saveVoiceCaptureAudio
  },
  images: { imageResourceStore },
  library: {
    createAuthorId: () => randomUUID(),
    createEntryId: () => randomUUID(),
    db,
    now: () => new Date(),
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
    now: () => new Date(),
    resolveOfflineGloss
  },
  notesReview: {
    attemptTtlMs: cardCreationAttemptTtlMs,
    createId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  relatedMaterial: { db, service: lexicalRelationService },
  pdfImport: {
    commands: pdfImportCommands,
    uploadLimitBytes: config.pdfUploadLimitBytes,
    // First status read after conversion idempotently parks the converted attempt at the shared Work-creation
    // review boundary (#750); the route attaches the resulting review to the view.
    beginReview: (userId, attemptId) => beginPdfReview(workCreationDependencies, userId, attemptId)
  },
  readingPosition: { db },
  preferences: { db },
  recitation: {
    createEntryId: () => randomUUID(),
    createId: () => randomUUID(),
    db,
    now: () => new Date()
  },
  search: { db },
  today: { db, now: () => new Date() },
  workCreation: workCreationDependencies,
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
  // Keep the raw adapter/process failure message in safe server logs only, tagged with the capture id and
  // the stable category — it never crosses the status API into the browser (#675).
  logFailure: ({ captureId, category, rawMessage }) =>
    server.log.error({ captureId, category, rawMessage }, "voice_capture_failed"),
  speech,
  // The speech boundary's report of whether a local provider is set up on this machine, so an empty
  // transcript is classified as genuine silence vs. missing voice setup (#675).
  speechConfigured: speechConfig.provider !== undefined,
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

// The recoverable staged PDF import engine (#721): the in-process worker that drives a claimed attempt
// through #701's structured conversion, checkpointing each validated range so a crash, cancel, or
// interrupt resumes without redoing committed work. The conversion backend is resolved honestly (see
// `resolveStructuredPdfRunner`): the real memory-bounded Docling worker on a supported platform, a
// visible `tool_missing` failure where it is unavailable, or — only under `PDF_IMPORT_FIXTURE_CONVERSION`
// (dev/E2E) — a deterministic runner that converts an embedded fixture from the uploaded bytes. It never
// publishes canned content from a user upload. Converting an attempt never creates a Work, ReadingUnit,
// or Block — publishing a converted attempt is #702.
// The structured PDF conversion backend (#701), resolved once and shared by both the import runner's
// range conversion and the OCR adapter's before/after page probe, so a single memory-bounded worker
// classifies native text throughout an attempt.
const pdfStructuredRunner = resolveStructuredPdfRunner({
  fixtureConversion: config.pdfImportFixtureConversion,
  pythonBinary: config.pdfPythonBinary,
  scriptPath: fileURLToPath(new URL("./files/pdf_to_docling.py", import.meta.url)),
  perRangeTimeoutMs: config.pdfTimeoutMs,
  memoryMib: config.pdfStructuredMemoryMib
});
const pdfImportRunner: PdfImportRunnerDependencies = {
  activeRuns: pdfImportActiveRuns,
  createRunToken: () => randomUUID(),
  db,
  // A stage that could not be removed after a terminal/cancel outcome stays VISIBLE in server logs
  // (never silently swallowed); its bytes linger until retried, per the cleanup-failure rule.
  logCleanupFailure: logPdfImportCleanupFailure,
  now: () => new Date(),
  // The real converter reads the learner's actual bytes; where it is unavailable the attempt fails
  // visibly rather than publishing fabricated content. `pnpm setup:pdf` provisions the real Docling
  // worker. The same resolved runner is shared as the OCR adapter's page probe, so one worker classifies
  // native-text before and after the OCR pass.
  runner: pdfStructuredRunner,
  // The durable OCR phase (#745) runs before structured conversion for a scanned/mixed English PDF,
  // resolved honestly (see `resolvePdfOcrAdapter`): the real bounded OCRmyPDF adapter on a supported
  // platform (named tool/language failure where unprovisioned), a visible `tool_missing` where it cannot
  // run, or — only under `PDF_IMPORT_FIXTURE_OCR` (dev/E2E) — a deterministic fixture transform. It never
  // publishes canned text from a user upload.
  ocrAdapter: resolvePdfOcrAdapter({
    fixtureOcr: config.pdfImportFixtureOcr,
    probe: pdfStructuredRunner,
    ocrBinary: config.pdfOcrBinary,
    tesseractBinary: config.pdfTesseractBinary,
    timeoutMs: config.pdfTimeoutMs,
    // A dot-prefixed sibling of the attempt stages: it can never collide with a uuid attempt id (whose
    // stage-id pattern excludes a leading dot), so a validated OCR output stages beside the originals
    // without clashing.
    outputStageRoot: join(config.pdfImportStageDir, ".ocr-output")
  }),
  stageStore: pdfImportStageStore
};
const PDF_IMPORT_POLL_MS = 1_000;
let pdfImportDraining = false;
// Convert one attempt at a time to empty on each tick (single admission is DB-enforced too); never
// overlap ticks so a slow conversion cannot double-claim the slot. A converted attempt is parked as
// `awaiting_review` (#750) — publication no longer happens here; it is driven later by a serialized
// Work-creation review decision, so this loop never writes a Work or bypasses the duplicate-review
// boundary. Failures are logged; the loop continues on the next tick.
const drainPdfImportQueue = async (): Promise<void> => {
  if (pdfImportDraining) {
    return;
  }
  pdfImportDraining = true;
  try {
    let result = await processNextPdfImport(pdfImportRunner);
    while (result.status !== "idle") {
      result = await processNextPdfImport(pdfImportRunner);
    }
  } catch (error) {
    server.log.error({ err: error }, "pdf_import_worker_failed");
  } finally {
    pdfImportDraining = false;
  }
};

// One idempotent shutdown path (#805) shared by SIGINT/SIGTERM, a compromised-lease abort, and a
// startup failure: stop background drains, stop accepting requests, then close PGlite and release the
// database lease so normal shutdown gives PGlite time to checkpoint and the directory is handed off
// cleanly. Guarded so close/release run exactly once no matter how many signals arrive.
const onShutdownSignal = (signal: NodeJS.Signals): void => {
  server.log.info({ signal }, "server_shutdown_signal");
  requestShutdown(0);
};
performShutdown = async (exitCode) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.off("SIGINT", onShutdownSignal);
  process.off("SIGTERM", onShutdownSignal);
  for (const interval of backgroundIntervals) {
    clearInterval(interval);
  }
  let code = exitCode;
  try {
    if (httpServerListening) {
      await server.close();
    }
    await managedDatabase.close();
  } catch (error) {
    server.log.error({ err: error }, "server_shutdown_failed");
    code = 1;
  }
  process.exit(code);
};
process.on("SIGINT", onShutdownSignal);
process.on("SIGTERM", onShutdownSignal);

try {
  await server.listen({ host: config.host, port: config.port });
  httpServerListening = true;
  server.log.info({ host: config.host, port: config.port }, "server_started");

  // Recover any voice captures a previous process left mid-flight (transcribing/tidying), then start the
  // background drain loop so queued clips are processed without the user waiting.
  const requeued = await requeueStalledVoiceCaptures(db);
  if (requeued > 0) {
    server.log.info({ requeued }, "voice_capture_requeued_stalled");
  }
  const voiceCaptureInterval = setInterval(() => {
    void drainVoiceCaptureQueue();
  }, VOICE_CAPTURE_POLL_MS);
  voiceCaptureInterval.unref();
  backgroundIntervals.push(voiceCaptureInterval);

  // Recover any PDF import a previous process left mid-conversion: mark abandoned `running` attempts
  // `interrupted` (retryable, never left running, never silently resumed), then start the single-active
  // drain loop so queued/retried attempts convert without the user waiting.
  const interruptedImports = await recoverInterruptedAttempts(db, new Date());
  if (interruptedImports > 0) {
    server.log.info({ interrupted: interruptedImports }, "pdf_import_recovered_interrupted");
  }
  const pdfImportInterval = setInterval(() => {
    void drainPdfImportQueue();
  }, PDF_IMPORT_POLL_MS);
  pdfImportInterval.unref();
  backgroundIntervals.push(pdfImportInterval);

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

  // Report the local speech-to-text wiring (#347, #799): a clear "run pnpm setup:voice" hint when voice
  // diary capture would otherwise silently transcribe to empty, and a migration hint when the config
  // still uses the legacy WHISPER_* pair or leaves stale WHISPER_* keys alongside the new pair.
  const speechHealth = checkSpeechHealth({ config: speechConfig });
  if (speechHealth.status === "fake") {
    server.log.warn({ speech: speechHealth.status }, speechHealth.message);
  } else {
    server.log.info({ speech: speechHealth.status }, speechHealth.message);
  }
} catch (error) {
  server.log.error({ err: error }, "server_start_failed");
  // Startup failure performs the same cleanup so the lease is released and the directory reopenable.
  await managedDatabase.close();
  process.exitCode = 1;
}
