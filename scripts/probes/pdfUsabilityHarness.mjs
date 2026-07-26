#!/usr/bin/env node
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
// BOUNDED-RUNNER INVARIANT (so the aggregate is equivalent to the real import lane): the harness drives
// the worker under the SAME per-child memory ceiling the production runner enforces, or it refuses to
// run. It (1) fences the same unsupported platforms the production runner does — reusing
// `canEnforceStructuredPdfMemoryCeiling`, so win32, where no POSIX address-space ceiling can be applied,
// is refused up front exactly like production's unavailable runner rather than measuring Docling
// memory-unbounded; (2) sets `WHETSTONE_PDF_MEMORY_MIB` (PDF_STRUCTURED_MEMORY_MIB, default 2048 MiB —
// mirroring the server config) on every worker child, so an over-ceiling conversion is killed here
// (worker exit 7 -> `memory`, counted against the gate) just as it would be in production; and (3)
// treats worker exit 8 (`memory_ceiling_unsupported`) as a fatal environment error that aborts the whole
// run — if the ceiling could not be enforced, the numbers are not falsifiable against production, so the
// harness must refuse rather than emit a report that would look passable while production would refuse.
//
// Usage (run under tsx so the TypeScript rubric/mapper import directly; build the workspace first):
//   pnpm build
//   node --import tsx scripts/probes/pdfUsabilityHarness.mjs --corpus <dir> [--extra <dir> ...] \
//     [--range-size N] [--timeout-ms N] [--limit N] [--memory-mib N] [--out report.json]
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
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const WORKER = join(REPO, "src/apps/server/src/files/pdf_to_docling.py");

// Exit-code contract of the pinned worker (mirrors scripts/probes/pdfStructuredCorpusProbe.mjs).
const EXIT = {
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
// Per-child address-space ceiling (MiB) the worker self-applies, matching the production runner. Mirrors
// serverConfig `defaultServerConfig.pdfStructuredMemoryMib` (2 GiB) and the same PDF_STRUCTURED_MEMORY_MIB
// env override, so the harness bounds each conversion exactly as the real import lane does.
const DEFAULT_MEMORY_MIB = 2048;

// Resolve the per-child memory ceiling like the server config's `parsePdfStructuredMemory`: a positive
// integer number of MiB, or the default when unset. A non-positive/non-integer request is rejected so the
// harness never silently runs with a broken ceiling.
function parseMemoryMib(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MEMORY_MIB;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      "PDF_STRUCTURED_MEMORY_MIB / --memory-mib must be a positive integer number of MiB."
    );
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    corpus: process.env.WHETSTONE_PDF_CORPUS ?? null,
    extra: [],
    rangeSize: DEFAULT_RANGE_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    limit: Infinity,
    memoryMib: parseMemoryMib(process.env.PDF_STRUCTURED_MEMORY_MIB),
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
    else if (flag === "--memory-mib") args.memoryMib = parseMemoryMib(argv[(i += 1)]);
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
// not cheaply available (win32). Identical approach to the structured-corpus probe.
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

// Run one worker invocation with a wall-clock timeout, sampling peak memory. The child inherits the
// SAME `WHETSTONE_PDF_MEMORY_MIB` ceiling the production runner sets (createDoclingRunner), so a
// conversion that would exceed it is killed by the worker's own address-space limit (exit 7) here just
// as in production — the measurement is not memory-unbounded.
function runWorker(python, workerArgs, timeoutMs, memoryMib) {
  return new Promise((resolvePromise) => {
    const child = spawn(python, [WORKER, ...workerArgs], {
      env: { ...process.env, WHETSTONE_PDF_MEMORY_MIB: String(memoryMib) }
    });
    const sampler = startPeakRssSampler(child.pid);
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const peakBytes = await sampler.stop();
      resolvePromise({ code: timedOut ? null : (code ?? 1), stdout, peakBytes, timedOut });
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

// Drive one file through probe -> ranges -> mapping, returning { observation, pageCount, peakBytes }.
// Corpus bounds are enforced BEFORE any expensive conversion work: an over-size or over-page PDF is
// outside the 95% denominator (assessCorpusEligibility excludes it), so it must not pay Docling
// convert time or memory. An out-of-bound early return still records the real sizeBytes/pageCount that
// trigger the exclusion; its observation is a never-classified placeholder because eligibility drops
// the case via `facts` before any observation is read.
async function convertOne(python, contracts, mapStructuredDocument, path, args, bounds) {
  const start = process.hrtime.bigint();
  let peakBytes = 0;
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;

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
  if (probe.timedOut)
    return { observation: { kind: "timeout" }, pageCount: null, peakBytes, elapsedMs: elapsed() };
  if (probe.code === EXIT.TOOL_MISSING) return { toolMissing: true };
  // The worker applies the memory ceiling before any command runs, so an environment that cannot enforce
  // it surfaces here first. It is not a per-file failure: the whole run's numbers would be unbounded and
  // non-equivalent to production, so abort rather than classify this file.
  if (probe.code === EXIT.MEMORY_CEILING_UNSUPPORTED) return { memoryCeilingUnsupported: true };
  if (probe.code !== EXIT.OK)
    return {
      observation: observationForExit(probe.code, "probe"),
      pageCount: null,
      peakBytes,
      elapsedMs: elapsed()
    };

  const probeParsed = contracts.parseProbeClassification(probe.stdout);
  if (probeParsed.status !== "ok")
    return {
      observation: { kind: "conversion_failed", detail: `probe ${probeParsed.status}` },
      pageCount: null,
      peakBytes,
      elapsedMs: elapsed()
    };
  const pageCount = probeParsed.pageCount;

  // The cheap probe gave the page count: exclude an over-page PDF here, before the range loop, so an
  // out-of-bound input never pays for full range conversion.
  if (pageCount > bounds.maxPages) {
    return { observation: { kind: "no_content" }, pageCount, peakBytes, elapsedMs: elapsed() };
  }

  const ranges = [];
  for (let startPage = 1; startPage <= pageCount; startPage += args.rangeSize) {
    const endPage = Math.min(startPage + args.rangeSize - 1, pageCount);
    const range = await runWorker(
      python,
      ["--range", path, String(startPage), String(endPage)],
      args.timeoutMs,
      args.memoryMib
    );
    peakBytes = Math.max(peakBytes, range.peakBytes ?? 0);
    if (range.timedOut)
      return { observation: { kind: "timeout" }, pageCount, peakBytes, elapsedMs: elapsed() };
    if (range.code === EXIT.TOOL_MISSING) return { toolMissing: true };
    if (range.code === EXIT.MEMORY_CEILING_UNSUPPORTED) return { memoryCeilingUnsupported: true };
    if (range.code !== EXIT.OK)
      return {
        observation: observationForExit(range.code, "range"),
        pageCount,
        peakBytes,
        elapsedMs: elapsed()
      };
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
}

async function loadTypeScriptDeps() {
  try {
    const contracts = await import("../../src/packages/contracts/src/index.js");
    const domain = await import("../../src/packages/domain/src/pdfUsability.js");
    const mapper =
      await import("../../src/apps/server/src/features/pdfImport/pdfCanonicalMapping.js");
    // Reuse the production runner's platform fence so the harness supports exactly the platforms the real
    // import lane does (a single source of truth for "where the memory ceiling can be enforced").
    const adapter = await import("../../src/apps/server/src/files/pdfStructuredAdapter.js");
    return {
      contracts,
      domain,
      mapStructuredDocument: mapper.mapStructuredDocument,
      canEnforceStructuredPdfMemoryCeiling: adapter.canEnforceStructuredPdfMemoryCeiling
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
  // -> createUnavailableDoclingRunner on win32): where no per-child address-space ceiling can be enforced,
  // production refuses the whole adapter rather than convert memory-unbounded, so the harness refuses the
  // whole run rather than emit an aggregate that would not be falsifiable against the real import lane.
  if (!deps.canEnforceStructuredPdfMemoryCeiling(process.platform)) {
    process.stderr.write(
      `error: a per-child memory ceiling cannot be enforced on platform "${process.platform}", so the ` +
        "structured PDF lane is unavailable here (same fence as the production runner). Run the harness " +
        "on a POSIX platform (Linux/macOS) where the worker can apply an address-space ceiling.\n"
    );
    return 4;
  }

  const python = resolvePython();
  if (python === null) {
    process.stderr.write(
      "error: Python 3 not found; run `pnpm setup:pdf` to enable the PDF lane.\n"
    );
    return 3;
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
      bounds
    );
    if (converted.toolMissing) {
      process.stderr.write("error: the pinned Docling runtime is missing; run `pnpm setup:pdf`.\n");
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

main().then((code) => {
  process.exitCode = code;
});
