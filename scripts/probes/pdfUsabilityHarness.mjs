// Reproducible private-corpus usability harness for the supported PDF lane (#705).
//
// It measures the ONE thing that defines "supported": how much of a real, private pressure corpus
// imports into a MATERIALLY USABLE canonical Work — not parser exit, page count, or visual rendering.
// For every deduplicated, in-bound PDF it drives the pinned structured pipeline
// (src/apps/server/src/files/pdf_to_docling.py) exactly as the server does, maps the validated output
// through the SAME canonical mapper the product uses (#702's `mapStructuredDocument`), and applies the
// pure usability rubric (@whetstone/domain `evaluateCorpusCase`). It then prints an AGGREGATE-ONLY
// report: counts, ratios, the 95% gate verdict, timing percentiles, peak memory, failure classes, and
// pinned tool fingerprints — never a file name, path, page image, or any extracted text — so the numbers
// can be attached to a PR while the corpus stays private.
//
// This is a MANUAL measurement tool, not part of `pnpm validate`. It needs the real pinned Docling
// runtime and the built workspace packages, and skips cleanly (a distinct exit code + message) when
// either is unavailable. The rubric it applies is unit-tested in
// src/packages/domain/src/pdfUsability.test.ts, so the harness owns only I/O and orchestration.
//
// OCR-EQUIVALENCE INVARIANT (so a scanned/mixed PDF is measured after the SAME OCR pass production runs):
// before the structured range conversion, each in-bound case is routed through the production OCR
// decision/source stage. The harness constructs the SAME seams the composition root wires
// (`resolveStructuredPdfRunner` as the OCR adapter's before/after page probe + `resolvePdfOcrAdapter`
// over OCRmyPDF/Tesseract), classifies routing from the per-page `hasNativeText` probe
// (`classifyOcrRouting`), and — when a durable OCR pass is required (`ocrPassRequired`) — runs the real
// adapter to produce a validated derived `ocr.pdf`, then range-converts THAT, exactly like
// `pdfImportRunner`'s `resolveConversionSource`. Provenance (byteLength/sha256) always stays the
// immutable original. This closes the divergence where an OCR-eligible scan would otherwise be reported
// as `ocr_required`/unsupported instead of measured as production imports it. When the corpus contains a
// scanned/mixed PDF but the OCR toolchain (or the chosen `--ocr-language` pack) is missing, the whole run
// aborts with a distinct exit code rather than emit a non-equivalent report. All OCR working files
// (staged source copies + validated outputs) live under one per-run temp root removed at the end of the run.
//
// BOUNDED-RUNNER INVARIANT (so the aggregate is equivalent to the real import lane): the harness drives
// the worker under the SAME per-child memory ceiling the production runner enforces, or it refuses to
// run. It (1) fences the same unsupported platforms the production runner does — reusing
// `canEnforceStructuredPdfMemoryCeiling` — and, before measuring, runs the worker's `--check-memory-ceiling`
// capability probe (exactly as `pnpm setup:pdf` does) to prove the platform boundary (Windows Job Object /
// POSIX RLIMIT_AS) actually holds on THIS host, aborting with an actionable `pnpm setup:pdf` remedy
// otherwise rather than measuring Docling memory-unbounded; (2) resolves the per-child ceiling from the
// single production owner (serverConfig `resolveStructuredPdfMemoryMib`: platform-aware default —
// 2,048 MiB POSIX / 6,144 MiB Windows — unless PDF_STRUCTURED_MEMORY_MIB / --memory-mib overrides it) and
// sets `WHETSTONE_PDF_MEMORY_MIB` on every worker child, so an over-ceiling conversion is killed here
// (worker exit 7 -> `memory`, counted against the gate) just as it would be in production; and (3)
// treats worker exit 8 (`memory_ceiling_unsupported`) as a fatal environment error that aborts the whole
// run — if the ceiling could not be enforced, the numbers are not falsifiable against production, so the
// harness must refuse rather than emit a report that would look passable while production would refuse.
// Peak memory comes from the external RSS sampler on POSIX and from the worker's Job Object metrics
// sidecar on Windows (whichever the platform can report).
//
// OUTPUT-CAP INVARIANT (so the harness can never overstate production support): production runs the worker
// through `execFile(..., { maxBuffer: MAX_WORKER_OUTPUT_BYTES })` (src/apps/server/src/files/
// pdfStructuredAdapter.ts), a 64 MiB stdout ceiling, and FAILS (child_crash -> failed import) any child
// whose output exceeds it. The harness applies the SAME cap: each worker run's stdout is accumulated
// through a bounded buffer that truncates and flags overflow at the cap, the over-cap child is killed, and
// the run is classified as an in-bound `conversion_failed` (counted against the 95% gate) rather than
// parsed from truncated output and counted as automatic/correctable. Without this, a large-but-in-bound
// range whose JSON exceeds 64 MiB would look measurable/passable here while production refuses it.
//
// Usage (run under tsx so the TypeScript rubric/mapper import directly; build the workspace first):
//   pnpm build
//   node --import tsx scripts/probes/pdfUsabilityHarness.mjs --corpus <dir> [--extra <dir> ...] \
//     [--range-size N] [--timeout-ms N] [--limit N] [--memory-mib N] [--out report.json] \
//     [--ocr-language en|zh-CN|zh-TW] [--ocr-binary ocrmypdf] [--tesseract-binary tesseract]
//   WHETSTONE_PDF_CORPUS=<dir> node --import tsx scripts/probes/pdfUsabilityHarness.mjs
//
// The baseline corpus root MUST be supplied explicitly (never hard-coded here). Additional --extra roots
// EXTEND, never replace, the baseline. An empty/missing corpus is a hard, actionable failure — the
// harness never substitutes fixtures or silently shrinks the denominator.
//
// `--limit N` is a LOCAL-ITERATION shortcut only: it processes just the first N deduplicated files, so the
// aggregate is over a prefix, not the real denominator. A limited run always reports `run.limited: true`
// and `corpusGatePass: false` and exits non-zero, so it can never be mistaken for #705 corpus evidence.
// Omit --limit for a gate-producing run.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const WORKER = join(REPO, "src/apps/server/src/files/pdf_to_docling.py");

// Exit-code contract of the pinned worker (mirrors scripts/probes/pdfStructuredCorpusProbe.mjs).
export const EXIT = {
  OK: 0,
  TOOL_MISSING: 3,
  CONVERSION_FAILED: 4,
  PASSWORD_REQUIRED: 5,
  UNSUPPORTED_SCHEMA: 6,
  MEMORY: 7,
  // The worker was asked for a per-child memory ceiling it could not enforce on this platform (POSIX
  // `resource` unavailable, e.g. win32). In LOCKSTEP with WORKER_EXIT_MEMORY_CEILING_UNSUPPORTED.
  MEMORY_CEILING_UNSUPPORTED: 8
};

const DEFAULT_RANGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MEMORY_SAMPLE_MS = 100;
const LOW_CONFIDENCE_THRESHOLD = 0.75; // Mirrors domain PDF_EXTRACTION_CONFIDENCE_THRESHOLD.

// Default OCR language the durable OCR phase runs a scanned/mixed PDF in when none is given. Production
// resolves this from the Work language; the corpus is language-unlabelled, so the harness defaults to
// English (override with --ocr-language) and validates it against the closed Work-language set below.
const DEFAULT_OCR_LANGUAGE = "en";
const WORK_LANGUAGES = new Set(["en", "zh-CN", "zh-TW"]);
// The production default OCR toolchain binaries (mirrors serverConfig `pdfOcrBinary` / `pdfTesseractBinary`).
const DEFAULT_OCR_BINARY = "ocrmypdf";
const DEFAULT_TESSERACT_BINARY = "tesseract";

// Resolve the per-child memory ceiling through the SAME production owner the server config uses
// (resolveStructuredPdfMemoryMib): a positive-integer PDF_STRUCTURED_MEMORY_MIB / --memory-mib override
// wins on every platform, otherwise the platform-aware default applies (2,048 MiB POSIX, 6,144 MiB
// Windows). The harness never duplicates those platform numbers — it holds only the raw override here and
// hands it to the imported resolver once the workspace is loaded, so it bounds each conversion exactly as
// the real import lane does.
function parseArgs(argv) {
  const args = {
    corpus: process.env.WHETSTONE_PDF_CORPUS ?? null,
    extra: [],
    rangeSize: DEFAULT_RANGE_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    limit: Infinity,
    memoryMibOverride: process.env.PDF_STRUCTURED_MEMORY_MIB,
    ocrLanguage: process.env.WHETSTONE_PDF_OCR_LANGUAGE ?? DEFAULT_OCR_LANGUAGE,
    ocrBinary: process.env.PDF_OCR_BINARY ?? DEFAULT_OCR_BINARY,
    tesseractBinary: process.env.PDF_TESSERACT_BINARY ?? DEFAULT_TESSERACT_BINARY,
    out: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--corpus") args.corpus = argv[(i += 1)] ?? args.corpus;
    else if (flag === "--extra") args.extra.push(argv[(i += 1)]);
    else if (flag === "--range-size")
      args.rangeSize = Math.max(1, Number.parseInt(argv[(i += 1)], 10) || DEFAULT_RANGE_SIZE);
    else if (flag === "--timeout-ms")
      args.timeoutMs = Math.max(1000, Number.parseInt(argv[(i += 1)], 10) || DEFAULT_TIMEOUT_MS);
    else if (flag === "--limit") args.limit = Math.max(1, Number.parseInt(argv[(i += 1)], 10) || 1);
    else if (flag === "--memory-mib") args.memoryMibOverride = argv[(i += 1)];
    else if (flag === "--ocr-language") args.ocrLanguage = argv[(i += 1)] ?? args.ocrLanguage;
    else if (flag === "--ocr-binary") args.ocrBinary = argv[(i += 1)] ?? args.ocrBinary;
    else if (flag === "--tesseract-binary")
      args.tesseractBinary = argv[(i += 1)] ?? args.tesseractBinary;
    else if (flag === "--out") args.out = argv[(i += 1)] ?? null;
    else if (args.corpus === null) args.corpus = flag;
  }
  return args;
}

function resolvePython() {
  for (const command of ["python", "python3"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) return command;
  }
  return null;
}

// The worker's cheap ceiling-capability probe: it exercises the real platform controller (a Job Object on
// Windows, RLIMIT_AS on POSIX) against THIS process and reports whether the per-child memory ceiling can
// actually be enforced here — not merely that a module imports or that the platform name looks supported.
// The harness runs it in preflight BEFORE any conversion, exactly as `pnpm setup:pdf` does, so a host
// where the ceiling cannot be applied is refused up front rather than measured memory-unbounded. It is
// deliberately run WITHOUT WHETSTONE_PDF_MEMORY_MIB so the worker applies its own small fixed test ceiling
// (proving enforceability, never allocating the production workload budget). Returns the worker exit code.
function checkMemoryCeiling(python) {
  const env = { ...process.env };
  delete env.WHETSTONE_PDF_MEMORY_MIB;
  const probe = spawnSync(python, [WORKER, "--check-memory-ceiling"], { encoding: "utf-8", env });
  return probe.status;
}

// Recursively list every .pdf under a root (case-insensitive), sorted for a stable index assignment.
function listPdfsRecursive(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

// SHA-256 chunk size: bounded memory, never a single full-file buffer.
const HASH_CHUNK_BYTES = 1 << 20; // 1 MiB.

// Stream the SHA-256 in bounded chunks so even a large in-bound PDF is hashed without ever being loaded
// into memory as one buffer. Over-size PDFs are excluded by `statSync` before this is ever called, so a
// multi-GiB out-of-scope file is never read here — the dedupe pass stays bounded and cannot stall or
// exhaust the run.
function sha256(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let bytesRead;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// Sample the child's resident memory while it runs; peak bytes, or null where another process's RSS is
// not cheaply available (win32, which reports peak through the worker's Job Object sidecar instead —
// see createWindowsMetricsSidecar). Identical approach to the structured-corpus probe.
function startPeakRssSampler(pid) {
  let peak = 0;
  let stopped = false;
  const readRssBytes = () => {
    try {
      if (process.platform === "linux") {
        const status = readFileSync(`/proc/${pid}/status`, "utf-8");
        const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        return match ? Number.parseInt(match[1], 10) * 1024 : 0;
      }
      if (process.platform === "darwin") {
        const ps = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf-8" });
        return ps.status === 0 ? (Number.parseInt(ps.stdout.trim(), 10) || 0) * 1024 : 0;
      }
    } catch {
      return 0;
    }
    return 0;
  };
  const sampled = process.platform === "linux" || process.platform === "darwin";
  const loop = async () => {
    while (!stopped) {
      peak = Math.max(peak, readRssBytes());
      await delay(MEMORY_SAMPLE_MS);
    }
  };
  const done = sampled ? loop() : Promise.resolve();
  return {
    async stop() {
      stopped = true;
      await done;
      return sampled ? peak : null;
    }
  };
}

// The per-child worker stdout ceiling. Mirrors MAX_WORKER_OUTPUT_BYTES in
// src/apps/server/src/files/pdfStructuredAdapter.ts, where production runs the worker via
// `execFile(..., { maxBuffer: MAX_WORKER_OUTPUT_BYTES })` and fails any child whose stdout exceeds it. The
// harness enforces the same cap so its aggregate cannot count an over-cap range as usable when production
// would refuse it. A worker change to this bound must move both sides in lockstep.
export const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;

// A bounded stdout accumulator matching `execFile`'s `maxBuffer` semantics: it appends decoded chunks
// until the byte cap is first exceeded, then reports overflow and retains no further output (production
// truncates and fails such a child). Pure and cap-injectable so the exact boundary is unit-tested without
// spawning a 64 MiB worker; `runWorker` uses the production default. `push` returns true once overflowed
// so the caller can kill the child.
export function createBoundedStdout(maxBytes = MAX_WORKER_OUTPUT_BYTES) {
  let text = "";
  let bytes = 0;
  let overflowed = false;
  return {
    push(chunk) {
      if (overflowed) return true;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflowed = true;
        return true;
      }
      text += chunk.toString("utf-8");
      return false;
    },
    get overflowed() {
      return overflowed;
    },
    text() {
      return text;
    }
  };
}

// The real spawn/sampler seam runWorker uses; injectable so the cap/kill wiring is testable with a fake
// child without a live Python worker. `createMetrics` provides the Windows peak-memory channel: the
// worker cannot cheaply sample another process's RSS on Windows, so a successful run writes its Job Object
// `PeakJobMemoryUsed` to a sidecar file (WHETSTONE_PDF_METRICS_PATH) the harness reads back. On POSIX it
// is a no-op and the external RSS sampler supplies the peak (matching how the server config's platform
// boundary reports peak). Omitted by test fakes, which need neither channel.
function createWindowsMetricsSidecar() {
  if (process.platform !== "win32") {
    return null;
  }
  const path = join(mkdtempSync(join(tmpdir(), "whetstone-pdf-metrics-")), "metrics.json");
  return {
    env: { WHETSTONE_PDF_METRICS_PATH: path },
    readPeakBytes() {
      try {
        const peak = JSON.parse(readFileSync(path, "utf-8")).peakMemoryBytes;
        return Number.isFinite(peak) && peak > 0 ? peak : null;
      } catch {
        return null;
      }
    },
    cleanup() {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort: a leftover metrics file in the OS temp dir is harmless.
      }
    }
  };
}

const defaultWorkerIo = {
  spawn,
  createSampler: startPeakRssSampler,
  createMetrics: createWindowsMetricsSidecar
};

// Run one worker invocation with a wall-clock timeout, sampling peak memory. The child inherits the
// SAME `WHETSTONE_PDF_MEMORY_MIB` ceiling the production runner sets (createDoclingRunner), so a
// conversion that would exceed it is killed by the worker's own memory boundary (exit 7) here just
// as in production — the measurement is not memory-unbounded. Peak memory comes from the external RSS
// sampler on POSIX and from the worker's Job Object sidecar on Windows (whichever the platform can
// report). Its stdout is bounded to the SAME 64 MiB output cap production enforces via
// `execFile({ maxBuffer })`: an over-cap child is killed and reported with `overCap`, so a range whose
// JSON exceeds the cap is classified as a failure (as production fails it) instead of being parsed from
// truncated output.
export function runWorker(python, workerArgs, timeoutMs, memoryMib, io = defaultWorkerIo) {
  return new Promise((resolvePromise) => {
    const metrics = io.createMetrics ? io.createMetrics() : null;
    const child = io.spawn(python, [WORKER, ...workerArgs], {
      env: {
        ...process.env,
        WHETSTONE_PDF_MEMORY_MIB: String(memoryMib),
        ...(metrics?.env ?? {})
      }
    });
    const sampler = io.createSampler(child.pid);
    const stdout = createBoundedStdout();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      // Push into the bounded buffer; once the production stdout cap is first exceeded, kill the child
      // (production truncates and fails such a run) rather than keep buffering unbounded output.
      if (stdout.push(chunk)) child.kill("SIGKILL");
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const samplerPeak = await sampler.stop();
      const sidecarPeak = metrics ? metrics.readPeakBytes() : null;
      if (metrics) metrics.cleanup();
      resolvePromise({
        code: timedOut ? null : (code ?? 1),
        stdout: stdout.text(),
        peakBytes: sidecarPeak ?? samplerPeak,
        timedOut,
        overCap: stdout.overflowed
      });
    });
  });
}

// Map a non-OK worker exit code to a rubric observation. `stage` disambiguates the worker's shared
// EXIT_CONVERSION_FAILED (exit 4): the worker returns it BOTH when it cannot open/probe a file (a
// corrupt input) AND when an openable, probeable file fails during range conversion (a genuine
// unsupported conversion). The probe stage is only reachable by opening the file, so a probe-stage
// exit 4 is corruption — excluded from the 95% denominator (`assessCorpusEligibility` drops `corrupt`)
// rather than counted as an unsupported failure. A range-stage exit 4 stays `conversion_failed`, so
// classifying corrupt inputs distinctly never hides a real conversion failure.
function observationForExit(code, stage) {
  if (code === EXIT.PASSWORD_REQUIRED) return { kind: "password_required" };
  if (code === EXIT.MEMORY) return { kind: "memory" };
  if (code === EXIT.UNSUPPORTED_SCHEMA)
    return { kind: "conversion_failed", detail: "unsupported docling schema" };
  if (code === EXIT.CONVERSION_FAILED && stage === "probe") return { kind: "corrupt" };
  return { kind: "conversion_failed", detail: `worker exit ${code}` };
}

// Interpret how a single worker run ended, at a given pipeline `stage`, into either a control signal the
// caller must act on (`{ abort }`), a rubric observation that classifies the file (`{ observation }`), or
// `null` when the run succeeded and its stdout should be parsed. This centralises every worker-run failure
// decision — including the OUTPUT-CAP INVARIANT: an over-cap run is a production failure (execFile's
// maxBuffer overflow -> child_crash -> failed import), so it is classified as an IN-BOUND
// `conversion_failed` that counts against the 95% gate, never parsed from truncated output. `timedOut`
// takes precedence over any exit code (the run was killed mid-flight); tool-missing and the worker's
// memory-ceiling-unsupported exit are fatal environment aborts.
export function interpretWorkerRun(run, stage) {
  if (run.timedOut) return { observation: { kind: "timeout" } };
  if (run.overCap)
    return {
      observation: {
        kind: "conversion_failed",
        detail: `worker stdout exceeded the ${MAX_WORKER_OUTPUT_BYTES}-byte production output cap`
      }
    };
  if (run.code === EXIT.TOOL_MISSING) return { abort: "toolMissing" };
  if (run.code === EXIT.MEMORY_CEILING_UNSUPPORTED) return { abort: "memoryCeilingUnsupported" };
  if (run.code !== EXIT.OK) return { observation: observationForExit(run.code, stage) };
  return null;
}

// Sum readable code points inside a ProseMirror node (recurses into content).
function nodeTextLength(node) {
  if (typeof node.text === "string") return node.text.length;
  if (!Array.isArray(node.content)) return 0;
  return node.content.reduce((total, child) => total + nodeTextLength(child), 0);
}

// Distil a mapped canonical Work into the rubric's MappedWorkSummary.
function summarizeMapped(mapping) {
  let blockCount = 0;
  let headingCount = 0;
  let unknownBlockCount = 0;
  let plainTextLength = 0;
  for (const unit of mapping.units) {
    for (const block of unit.docBlocks) {
      blockCount += 1;
      if (block.node.type === "heading") headingCount += 1;
      if (block.node.type === "unknown") unknownBlockCount += 1;
      plainTextLength += nodeTextLength(block.node);
    }
  }
  const lowConfidenceBlockCount = mapping.evidence.filter(
    (item) => item.confidence < LOW_CONFIDENCE_THRESHOLD
  ).length;
  return { blockCount, headingCount, lowConfidenceBlockCount, plainTextLength, unknownBlockCount };
}

// Convert a mapping result into a rubric observation.
function observationForMapping(mapping) {
  switch (mapping.status) {
    case "ocr_validation_failed":
      return { kind: "ocr_required", pagesNeedingOcr: mapping.pagesNeedingOcr };
    case "no_content":
      return { kind: "no_content" };
    case "image_unsupported":
      return { kind: "image_unsupported", unpreservableImages: mapping.unpreservableImages };
    default:
      return { kind: "mapped", summary: summarizeMapped(mapping) };
  }
}

// Map a non-`ok` OCR outcome to either a whole-run ABORT or a per-file rubric observation, matching what
// production does with the same failure:
//   - `tool_missing` / `language_missing` are provisioning gaps in THIS environment, not properties of a
//     single PDF (the harness picks one OCR language for the run, so a missing pack is not a per-file
//     fact). A memory-unbounded/OCR-less run is not falsifiable against production, so abort the whole run
//     — a report is only ever emitted when the real OCR toolchain and language pack actually ran;
//   - `timeout` / `memory` stay their own rubric classes, exactly as the structured lane classifies them;
//   - every other failure (geometry, native_text, output_validation, routing_mismatch, unsupported_input,
//     child_crash, stage_write, cleanup) is a genuine per-file OCR failure production would FAIL the import
//     on, so it counts against the 95% gate as `conversion_failed` rather than being hidden.
function ocrOutcomeForFailure(failure) {
  if (failure.kind === "tool_missing") return { abort: "ocrToolMissing" };
  if (failure.kind === "language_missing") {
    return { abort: "ocrLanguageMissing", detail: failure.what };
  }
  if (failure.kind === "timeout") return { observation: { kind: "timeout" } };
  if (failure.kind === "memory") return { observation: { kind: "memory" } };
  return { observation: { kind: "conversion_failed", detail: `ocr ${failure.kind}` } };
}

// Resolve which staged file structured range conversion reads, running the SAME durable OCR phase the
// production runner does (src/.../pdfImportRunner.ts `resolveConversionSource`): classify OCR routing from
// the probe's per-page native-text flags, and for a scanned/mixed PDF run one bounded, validated OCRmyPDF
// pass through the real production adapter, then convert the DERIVED `ocr.pdf` — so an OCR-eligible scan is
// measured after the OCR pass ingestion actually uses, not reported as `ocr_required`/unsupported. A
// born-digital (`native`) document converts the ORIGINAL untouched. Returns `{ path }` (the conversion
// source), `{ abort }` (an environment gap that invalidates the whole run), or `{ observation }` (a
// per-file OCR failure). Any temporary staging is registered in `cleanupPaths` for the caller to remove.
async function resolveOcrConversionSource(path, probePages, args, ocr, cleanupPaths) {
  const routing = ocr.classifyOcrRouting(
    probePages.map((page) => ({ pageNumber: page.pageNumber, hasNativeText: page.hasNativeText }))
  );
  if (!ocr.ocrPassRequired(routing.kind)) {
    return { path };
  }

  // The OCR adapter reads through a SERVER-ISSUED handle whose name must be a simple, path-safe token, so
  // stage the corpus PDF under a fixed `source.pdf` name in the run temp root. The source is already
  // in-bound (<= MAX_STAGED_BYTES; over-size files never reach here), so a plain COPY is bounded and works
  // on every supported host — including Windows, where a POSIX symlink is unavailable (#782).
  const stageDir = mkdtempSync(join(ocr.tempRoot, "src-"));
  cleanupPaths.push(stageDir);
  copyFileSync(path, join(stageDir, "source.pdf"));
  const source = ocr.issueStagedFileHandle(stageDir, "source.pdf");

  const outcome = await ocr.adapter.execute({ source, routing, language: ocr.language });
  if (!outcome.ok) {
    return ocrOutcomeForFailure(outcome.failure);
  }
  // The validated OCR output is owned by the harness now; remove it after conversion.
  cleanupPaths.push(outcome.result.output.path);
  return { path: outcome.result.output.path };
}

// Drive one file through probe -> (OCR when scanned/mixed) -> ranges -> mapping, returning
// { observation, pageCount, peakBytes }. Corpus bounds are enforced BEFORE any expensive conversion work:
// an over-size or over-page PDF is outside the 95% denominator (assessCorpusEligibility excludes it), so it
// must not pay Docling convert time or memory. An out-of-bound early return still records the real
// sizeBytes/pageCount that trigger the exclusion; its observation is a never-classified placeholder because
// eligibility drops the case via `facts` before any observation is read.
async function convertOne(python, contracts, mapStructuredDocument, path, args, bounds, ocr) {
  const start = process.hrtime.bigint();
  let peakBytes = 0;
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
  const cleanupPaths = [];

  try {
    // Size is known from the filesystem alone: exclude an over-size PDF before spawning the worker.
    const sizeBytes = statSync(path).size;
    if (sizeBytes > bounds.maxBytes) {
      return {
        observation: { kind: "no_content" },
        pageCount: null,
        peakBytes,
        elapsedMs: elapsed()
      };
    }

    const probe = await runWorker(python, ["--probe", path], args.timeoutMs, args.memoryMib);
    peakBytes = Math.max(peakBytes, probe.peakBytes ?? 0);
    // Interpret how the probe run ended (timeout, over-cap, tool-missing, memory-ceiling, or a non-OK
    // worker exit). A tool-missing / memory-ceiling abort is fatal to the whole run — the worker applies
    // the memory ceiling before any command runs and the numbers would be non-equivalent to production —
    // so it propagates rather than classifying this one file.
    const probeFailure = interpretWorkerRun(probe, "probe");
    if (probeFailure) {
      if (probeFailure.abort === "toolMissing") return { toolMissing: true };
      if (probeFailure.abort === "memoryCeilingUnsupported") return { memoryCeilingUnsupported: true };
      return {
        observation: probeFailure.observation,
        pageCount: null,
        peakBytes,
        elapsedMs: elapsed()
      };
    }

    const probeParsed = contracts.parseProbeClassification(probe.stdout);
    if (probeParsed.status !== "ok")
      return {
        observation: { kind: "conversion_failed", detail: `probe ${probeParsed.status}` },
        pageCount: null,
        peakBytes,
        elapsedMs: elapsed()
      };
    const pageCount = probeParsed.pageCount;

    // The cheap probe gave the page count: exclude an over-page PDF here, before OCR or the range loop, so
    // an out-of-bound input never pays for full range conversion.
    if (pageCount > bounds.maxPages) {
      return { observation: { kind: "no_content" }, pageCount, peakBytes, elapsedMs: elapsed() };
    }

    // The durable OCR phase, before structured conversion — exactly as production sequences it. A
    // scanned/mixed PDF is OCR'd and its DERIVED source converted; a born-digital PDF converts the
    // original. An environment gap aborts; a per-file OCR failure is classified against the gate.
    const conversion = await resolveOcrConversionSource(
      path,
      probeParsed.pages,
      args,
      ocr,
      cleanupPaths
    );
    if (conversion.abort === "ocrToolMissing") return { ocrToolMissing: true };
    if (conversion.abort === "ocrLanguageMissing") return { ocrLanguageMissing: conversion.detail };
    if (conversion.observation)
      return { observation: conversion.observation, pageCount, peakBytes, elapsedMs: elapsed() };
    const conversionPath = conversion.path;

    const ranges = [];
    for (let startPage = 1; startPage <= pageCount; startPage += args.rangeSize) {
      const endPage = Math.min(startPage + args.rangeSize - 1, pageCount);
      const range = await runWorker(
        python,
        ["--range", conversionPath, String(startPage), String(endPage)],
        args.timeoutMs,
        args.memoryMib
      );
      peakBytes = Math.max(peakBytes, range.peakBytes ?? 0);
      const rangeFailure = interpretWorkerRun(range, "range");
      if (rangeFailure) {
        if (rangeFailure.abort === "toolMissing") return { toolMissing: true };
        if (rangeFailure.abort === "memoryCeilingUnsupported")
          return { memoryCeilingUnsupported: true };
        return {
          observation: rangeFailure.observation,
          pageCount,
          peakBytes,
          elapsedMs: elapsed()
        };
      }
      const parsed = contracts.parseRangeConversion(range.stdout);
      if (parsed.status !== "ok")
        return {
          observation: { kind: "conversion_failed", detail: `range ${parsed.status}` },
          pageCount,
          peakBytes,
          elapsedMs: elapsed()
        };
      ranges.push(parsed.value);
    }

    // Provenance is always the IMMUTABLE ORIGINAL (byte length + hash), even when the converted bytes came
    // from the derived OCR PDF — matching production, where the original upload is the Work's provenance.
    const document = contracts.concatenateRanges(
      { byteLength: statSync(path).size, pageCount, sha256: sha256(path) },
      ranges
    );
    const mapping = mapStructuredDocument(document);
    return {
      observation: observationForMapping(mapping),
      pageCount,
      peakBytes,
      elapsedMs: elapsed()
    };
  } finally {
    for (const target of cleanupPaths) {
      try {
        rmSync(target, { force: true, recursive: true });
      } catch {
        // Best-effort: a stale symlink/derived file in the run's own temp root is harmless and the whole
        // root is removed at the end of the run.
      }
    }
  }
}

async function loadTypeScriptDeps() {
  try {
    const contracts = await import("../../src/packages/contracts/src/index.js");
    const domain = await import("../../src/packages/domain/src/pdfUsability.js");
    // #704's pure OCR-routing policy (native/scanned/mixed) — the same decision production drives.
    const ocrPolicy = await import("../../src/packages/domain/src/pdfOcr.js");
    const mapper =
      await import("../../src/apps/server/src/features/pdfImport/pdfCanonicalMapping.js");
    // Reuse the production runner's platform fence so the harness supports exactly the platforms the real
    // import lane does (a single source of truth for "where the memory ceiling can be enforced"), and its
    // server-issued staged-handle mint so the OCR adapter reads the corpus PDF exactly as it reads an
    // uploaded stage.
    const adapter = await import("../../src/apps/server/src/files/pdfStructuredAdapter.js");
    // The SAME production seams the composition root wires (src/apps/server/src/index.ts): the memory-
    // bounded structured runner and the bounded OCR adapter, so the harness routes each in-bound case
    // through the real OCR decision/source stage before mapping rather than a divergent reimplementation.
    const structuredResolution =
      await import("../../src/apps/server/src/files/pdfStructuredRunnerResolution.js");
    const ocrResolution = await import("../../src/apps/server/src/files/pdfOcrRunnerResolution.js");
    // The single production owner of the per-child memory default (2,048 MiB POSIX, 6,144 MiB Windows) and
    // override precedence, so the harness resolves the SAME ceiling the server does without duplicating the
    // platform numbers here.
    const serverConfig = await import("../../src/apps/server/src/config/serverConfig.js");
    return {
      contracts,
      domain,
      mapStructuredDocument: mapper.mapStructuredDocument,
      canEnforceStructuredPdfMemoryCeiling: adapter.canEnforceStructuredPdfMemoryCeiling,
      issueStagedFileHandle: adapter.issueStagedFileHandle,
      classifyOcrRouting: ocrPolicy.classifyOcrRouting,
      ocrPassRequired: ocrPolicy.ocrPassRequired,
      resolveStructuredPdfRunner: structuredResolution.resolveStructuredPdfRunner,
      resolvePdfOcrAdapter: ocrResolution.resolvePdfOcrAdapter,
      resolveStructuredPdfMemoryMib: serverConfig.resolveStructuredPdfMemoryMib
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.corpus) {
    process.stderr.write(
      "error: no corpus root. Pass --corpus <dir> or set WHETSTONE_PDF_CORPUS. The harness never " +
        "substitutes fixtures.\n"
    );
    return 2;
  }

  const deps = await loadTypeScriptDeps();
  if (deps.error) {
    process.stderr.write(
      `error: could not load the built workspace (run \`pnpm build\` first): ${deps.error}\n`
    );
    return 3;
  }
  const { contracts, domain } = deps;

  // Fence unsupported platforms up front, exactly like the production runner (resolveStructuredPdfRunner
  // -> createUnavailableDoclingRunner where the ceiling cannot be applied): where no per-child memory
  // ceiling can be enforced, production refuses the whole adapter rather than convert memory-unbounded, so
  // the harness refuses the whole run rather than emit an aggregate that would not be falsifiable against
  // the real import lane. The Windows Job Object / POSIX RLIMIT_AS boundary is supported on both platforms.
  if (!deps.canEnforceStructuredPdfMemoryCeiling(process.platform)) {
    process.stderr.write(
      `error: a per-child memory ceiling cannot be enforced on platform "${process.platform}", so the ` +
        "structured PDF lane is unavailable here (same fence as the production runner).\n"
    );
    return 4;
  }

  // Resolve the per-child ceiling from the SINGLE production owner (serverConfig): platform-aware default
  // (2,048 MiB POSIX / 6,144 MiB Windows) unless --memory-mib / PDF_STRUCTURED_MEMORY_MIB overrides it.
  // The resolver rejects a non-positive / non-integer override, which is an operator error, not a run.
  try {
    args.memoryMib = deps.resolveStructuredPdfMemoryMib(args.memoryMibOverride, process.platform);
  } catch (cause) {
    process.stderr.write(
      `error: invalid memory ceiling: ${cause instanceof Error ? cause.message : cause}\n`
    );
    return 2;
  }

  const python = resolvePython();
  if (python === null) {
    process.stderr.write(
      "error: Python 3 not found; run `pnpm setup:pdf` to enable the PDF lane.\n"
    );
    return 3;
  }

  // Prove the platform memory boundary actually holds on THIS host before measuring anything — the same
  // capability probe `pnpm setup:pdf` runs. On Windows this fails when pywin32 is missing so no Job Object
  // can be created; refuse up front with an actionable remedy rather than measure memory-unbounded.
  const ceilingStatus = checkMemoryCeiling(python);
  if (ceilingStatus !== 0) {
    process.stderr.write(
      "error: the per-child memory ceiling could not be enforced by the worker on this host " +
        `(check exited ${ceilingStatus === null ? "via signal" : ceilingStatus}). ` +
        "Run `pnpm setup:pdf` to provision the memory boundary (on Windows this installs pywin32).\n"
    );
    return 4;
  }

  // The OCR language the durable OCR phase runs a scanned/mixed PDF in. Production resolves it from the
  // Work language; the corpus is language-unlabelled, so it is one closed-set value per run.
  if (!WORK_LANGUAGES.has(args.ocrLanguage)) {
    process.stderr.write(
      `error: --ocr-language must be one of ${[...WORK_LANGUAGES].join(", ")} (got "${args.ocrLanguage}").\n`
    );
    return 2;
  }

  const roots = [args.corpus, ...args.extra].filter(Boolean).map((root) => resolve(root));
  let files = [];
  for (const root of roots) {
    try {
      files.push(...listPdfsRecursive(root));
    } catch (cause) {
      process.stderr.write(
        `error: could not read corpus root ${root}: ${cause instanceof Error ? cause.message : cause}\n`
      );
      return 1;
    }
  }

  const bounds = { maxBytes: contracts.MAX_STAGED_BYTES, maxPages: contracts.MAX_PAGE_COUNT };

  // Deduplicate the corpus, but keep the pre-conversion path BOUNDED: `statSync` the size first, before
  // reading a single byte. An over-size PDF is outside the 95% denominator (assessCorpusEligibility
  // excludes it), so it must be recognised and excluded without ever loading the whole file into memory
  // or reaching Docling — otherwise a single multi-GiB out-of-scope file could stall or exhaust the
  // reproducible run the gate depends on. In-bound files are deduped by a streaming SHA-256 (bounded
  // chunks, never a full-file buffer); the first path wins and no path ever enters the report. Over-size
  // files are deduped by resolved path (overlapping roots never record the same file twice) — content
  // dedupe is unnecessary and would require the very read we must avoid, and it cannot affect the gate
  // because the case is excluded regardless. Over-size files still flow through so they are counted as
  // excluded; `convertOne` re-checks the size and returns without spawning the worker.
  const seen = new Set();
  const seenOversize = new Set();
  const unique = [];
  for (const path of files) {
    if (statSync(path).size > bounds.maxBytes) {
      if (seenOversize.has(path)) continue;
      seenOversize.add(path);
      unique.push(path);
      continue;
    }
    const digest = sha256(path);
    if (seen.has(digest)) continue;
    seen.add(digest);
    unique.push(path);
  }
  if (unique.length === 0) {
    process.stderr.write(
      `error: no .pdf files under ${roots.join(", ")}. The corpus is required and must be non-empty.\n`
    );
    return 1;
  }

  // Construct the SAME production seams the composition root wires, so each in-bound case is measured
  // through the real pipeline: the memory-bounded structured runner serves as the OCR adapter's before/
  // after page probe, and the bounded OCRmyPDF adapter runs the durable OCR phase for scanned/mixed PDFs.
  // A per-run temp root holds every OCR working file (source symlinks + validated outputs) under one
  // directory removed at the end of the run.
  const runTempRoot = mkdtempSync(join(tmpdir(), "whetstone-pdf-harness-"));
  const structuredRunner = deps.resolveStructuredPdfRunner({
    fixtureConversion: false,
    pythonBinary: python,
    scriptPath: WORKER,
    perRangeTimeoutMs: args.timeoutMs,
    memoryMib: args.memoryMib
  });
  const ocr = {
    adapter: deps.resolvePdfOcrAdapter({
      fixtureOcr: false,
      probe: structuredRunner,
      ocrBinary: args.ocrBinary,
      tesseractBinary: args.tesseractBinary,
      timeoutMs: args.timeoutMs,
      outputStageRoot: join(runTempRoot, "ocr-output")
    }),
    classifyOcrRouting: deps.classifyOcrRouting,
    ocrPassRequired: deps.ocrPassRequired,
    issueStagedFileHandle: deps.issueStagedFileHandle,
    language: args.ocrLanguage,
    tempRoot: runTempRoot
  };

  try {
    return await runCorpus(python, contracts, domain, deps, args, bounds, ocr, files, unique);
  } finally {
    try {
      rmSync(runTempRoot, { force: true, recursive: true });
    } catch {
      // Best-effort: the OS temp directory reclaims a leftover run root; a removal failure is not a
      // product failure of the measurement.
    }
  }
}

// Drive every deduplicated file through the production pipeline and emit the aggregate report. Split from
// `main` so the run's temp root has a single try/finally cleanup surface around all conversion work.
async function runCorpus(python, contracts, domain, deps, args, bounds, ocr, files, unique) {
  const cases = [];
  let index = 0;
  for (const path of unique) {
    if (index >= args.limit) break;
    index += 1;
    const caseId = `case-${index}`;
    const sizeBytes = statSync(path).size;
    const converted = await convertOne(
      python,
      contracts,
      deps.mapStructuredDocument,
      path,
      args,
      bounds,
      ocr
    );
    if (converted.toolMissing) {
      process.stderr.write("error: the pinned Docling runtime is missing; run `pnpm setup:pdf`.\n");
      return 3;
    }
    if (converted.ocrToolMissing) {
      // A scanned/mixed PDF needs the OCR toolchain the real import lane uses; without it the run cannot
      // measure the production pipeline for scanned inputs, so abort rather than emit a non-equivalent
      // report.
      process.stderr.write(
        "error: the pinned OCR toolchain (OCRmyPDF over Tesseract) is missing, but the corpus contains a " +
          "scanned/mixed PDF that production would OCR. Run `pnpm setup:pdf` to provision it.\n"
      );
      return 3;
    }
    if (converted.ocrLanguageMissing) {
      process.stderr.write(
        `error: the OCR run cannot proceed: ${converted.ocrLanguageMissing} Install the language pack (` +
          "`pnpm setup:pdf`) or choose an installed --ocr-language.\n"
      );
      return 3;
    }
    if (converted.memoryCeilingUnsupported) {
      // Defense in depth behind the up-front platform fence: the worker itself refused because it could
      // not enforce the requested ceiling (worker exit 8). Abort the whole run — a memory-unbounded
      // measurement is not equivalent to production, so no aggregate is emitted.
      process.stderr.write(
        `error: the worker could not enforce the ${args.memoryMib} MiB per-child memory ceiling in this ` +
          "environment (WHETSTONE_PDF_MEMORY_MIB), so the run would not be falsifiable against the " +
          "production import lane. Run on a POSIX platform (Linux/macOS) where the ceiling can be applied.\n"
      );
      return 4;
    }
    const result = domain.evaluateCorpusCase({
      bounds,
      caseId,
      facts: { pageCount: converted.pageCount, sizeBytes },
      metrics: {
        elapsedMs: Math.round(converted.elapsedMs),
        pageCount: converted.pageCount,
        peakMemoryMib:
          converted.peakBytes > 0 ? Math.round(converted.peakBytes / (1024 * 1024)) : null
      },
      observation: converted.observation
    });
    cases.push(result);
  }

  // Disclose the corpus coverage so a limited run can never be mistaken for corpus evidence: a `--limit`
  // (or any early stop) processes only a PREFIX of the deduplicated corpus, so its rubric ratio is not
  // the #705 denominator. `discovered` counts every .pdf path found across roots (pre-dedupe),
  // `deduplicated` the unique files after dedupe (in-bound files by streaming SHA-256, over-size files
  // by path; the intended denominator source), `processed`
  // the files actually driven through the pipeline this run, and `limited` is true whenever fewer than
  // every deduplicated file was processed.
  const discovered = files.length;
  const deduplicated = unique.length;
  const processed = cases.length;
  const limited = processed < deduplicated;

  // AGGREGATE-ONLY report: histograms, ratios, the gate verdict, timing percentiles, peak memory, and
  // pinned tool fingerprints — never a per-file row (no caseId/class/page/time per PDF), so the output
  // can be pasted as the #705/#779 acceptance evidence while the corpus stays private.
  const report = domain.summarizeCorpus(cases);
  // The authoritative corpus gate: the rubric ratio only counts as #705 evidence when EVERY deduplicated
  // file was processed. A limited run is never a pass, no matter how good the prefix looks.
  const corpusGatePass = report.gatePass && !limited;
  const output = {
    gateRatioTarget: domain.PDF_USABILITY_GATE_RATIO,
    corpusGatePass,
    run: { discovered, deduplicated, processed, limited },
    report,
    tooling: {
      doclingCoreVersion: contracts.PINNED_DOCLING_CORE_VERSION,
      doclingVersion: contracts.PINNED_DOCLING_VERSION,
      modelCommit: contracts.PINNED_MODEL_COMMIT
    }
  };
  const serialized = JSON.stringify(output, null, 2);
  if (args.out) writeFileSync(args.out, serialized + "\n");
  else process.stdout.write(serialized + "\n");
  if (limited) {
    process.stderr.write(
      `warning: limited run — processed ${processed} of ${deduplicated} deduplicated PDFs (--limit). ` +
        "This is NOT corpus evidence; corpusGatePass is false and the exit code is non-zero. Remove " +
        "--limit for a gate-producing run.\n"
    );
  }
  return corpusGatePass ? 0 : 1;
}

// Only run when invoked directly (node scripts/probes/pdfUsabilityHarness.mjs); importing the module for
// its exported pure decisions (e.g. unit tests) must not start a corpus run.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
