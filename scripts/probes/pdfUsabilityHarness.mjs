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
// Usage (run under tsx so the TypeScript rubric/mapper import directly; build the workspace first):
//   pnpm build
//   node --import tsx scripts/probes/pdfUsabilityHarness.mjs --corpus <dir> [--extra <dir> ...] \
//     [--range-size N] [--timeout-ms N] [--limit N] [--out report.json]
//   WHETSTONE_PDF_CORPUS=<dir> node --import tsx scripts/probes/pdfUsabilityHarness.mjs
//
// The baseline corpus root MUST be supplied explicitly (never hard-coded here). Additional --extra roots
// EXTEND, never replace, the baseline. An empty/missing corpus is a hard, actionable failure — the
// harness never substitutes fixtures or silently shrinks the denominator.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  MEMORY: 7
};

const DEFAULT_RANGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MEMORY_SAMPLE_MS = 100;
const LOW_CONFIDENCE_THRESHOLD = 0.75; // Mirrors domain PDF_EXTRACTION_CONFIDENCE_THRESHOLD.

function parseArgs(argv) {
  const args = {
    corpus: process.env.WHETSTONE_PDF_CORPUS ?? null,
    extra: [],
    rangeSize: DEFAULT_RANGE_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    limit: Infinity,
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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

// Run one worker invocation with a wall-clock timeout, sampling peak memory.
function runWorker(python, workerArgs, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(python, [WORKER, ...workerArgs]);
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

// Map a non-OK worker exit code to a rubric observation.
function observationForExit(code) {
  if (code === EXIT.PASSWORD_REQUIRED) return { kind: "password_required" };
  if (code === EXIT.MEMORY) return { kind: "memory" };
  if (code === EXIT.UNSUPPORTED_SCHEMA)
    return { kind: "conversion_failed", detail: "unsupported docling schema" };
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
async function convertOne(python, contracts, mapStructuredDocument, path, args) {
  const start = process.hrtime.bigint();
  let peakBytes = 0;
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;

  const probe = await runWorker(python, ["--probe", path], args.timeoutMs);
  peakBytes = Math.max(peakBytes, probe.peakBytes ?? 0);
  if (probe.timedOut) return { observation: { kind: "timeout" }, pageCount: null, peakBytes, elapsedMs: elapsed() };
  if (probe.code === EXIT.TOOL_MISSING) return { toolMissing: true };
  if (probe.code !== EXIT.OK)
    return { observation: observationForExit(probe.code), pageCount: null, peakBytes, elapsedMs: elapsed() };

  const probeParsed = contracts.parseProbeClassification(probe.stdout);
  if (probeParsed.status !== "ok")
    return {
      observation: { kind: "conversion_failed", detail: `probe ${probeParsed.status}` },
      pageCount: null,
      peakBytes,
      elapsedMs: elapsed()
    };
  const pageCount = probeParsed.pageCount;

  const ranges = [];
  for (let startPage = 1; startPage <= pageCount; startPage += args.rangeSize) {
    const endPage = Math.min(startPage + args.rangeSize - 1, pageCount);
    const range = await runWorker(
      python,
      ["--range", path, String(startPage), String(endPage)],
      args.timeoutMs
    );
    peakBytes = Math.max(peakBytes, range.peakBytes ?? 0);
    if (range.timedOut)
      return { observation: { kind: "timeout" }, pageCount, peakBytes, elapsedMs: elapsed() };
    if (range.code !== EXIT.OK)
      return { observation: observationForExit(range.code), pageCount, peakBytes, elapsedMs: elapsed() };
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
  return { observation: observationForMapping(mapping), pageCount, peakBytes, elapsedMs: elapsed() };
}

async function loadTypeScriptDeps() {
  try {
    const contracts = await import("../../src/packages/contracts/src/index.js");
    const domain = await import("../../src/packages/domain/src/pdfUsability.js");
    const mapper = await import(
      "../../src/apps/server/src/features/pdfImport/pdfCanonicalMapping.js"
    );
    return { contracts, domain, mapStructuredDocument: mapper.mapStructuredDocument };
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

  const python = resolvePython();
  if (python === null) {
    process.stderr.write("error: Python 3 not found; run `pnpm setup:pdf` to enable the PDF lane.\n");
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

  // Deduplicate by source SHA-256; the first path wins, but no path ever enters the report.
  const seen = new Set();
  const unique = [];
  for (const path of files) {
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

  const bounds = { maxBytes: contracts.MAX_STAGED_BYTES, maxPages: contracts.MAX_PAGE_COUNT };
  const cases = [];
  const perCase = [];
  let index = 0;
  for (const path of unique) {
    if (index >= args.limit) break;
    index += 1;
    const caseId = `case-${index}`;
    const sizeBytes = statSync(path).size;
    const converted = await convertOne(python, contracts, deps.mapStructuredDocument, path, args);
    if (converted.toolMissing) {
      process.stderr.write("error: the pinned Docling runtime is missing; run `pnpm setup:pdf`.\n");
      return 3;
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
    perCase.push({
      caseId,
      class: result.verdict ? result.verdict.class : null,
      elapsedMs: result.metrics.elapsedMs,
      excludedReason: result.eligibility.included ? null : result.eligibility.reason,
      pageCount: result.metrics.pageCount,
      reason: result.verdict ? result.verdict.reason : null
    });
  }

  const report = domain.summarizeCorpus(cases);
  const output = {
    cases: perCase,
    gateRatioTarget: domain.PDF_USABILITY_GATE_RATIO,
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
  return report.gatePass ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
});
