#!/usr/bin/env node
// Private-corpus probe for the bounded structured PDF adapter (#701).
//
// Runs the pinned Docling worker (src/apps/server/src/files/pdf_to_docling.py) over a LOCAL, private
// corpus of born-digital PDFs and records ONLY aggregate metrics per file — page count, elapsed time,
// peak worker memory, result class, and validated schema version. It never copies a file name, path,
// or any extracted text/content into its output, so the numbers can be shared or committed while the
// corpus stays private. This is a manual measurement tool, not part of `pnpm validate`; it needs the
// real pinned Docling runtime and skips cleanly when Python/Docling is unavailable.
//
// Usage:
//   node scripts/probes/pdfStructuredCorpusProbe.mjs <corpus-dir> [--range-size N] [--out file.jsonl]
//   WHETSTONE_PDF_CORPUS=<corpus-dir> node scripts/probes/pdfStructuredCorpusProbe.mjs
//
// Output: one JSON object per file on stdout (or --out), then a summary object. Files are identified
// only by a 1-based index, never by name.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WORKER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/apps/server/src/files/pdf_to_docling.py"
);
const DEFAULT_RANGE_SIZE = 50; // Mirrors the adapter's default pageRangeSize.
const MEMORY_SAMPLE_MS = 100;

const EXIT_NAMES = {
  0: "ok",
  2: "usage",
  3: "tool_missing",
  4: "conversion_failed",
  5: "password_required",
  6: "unsupported_schema",
  7: "memory"
};

function parseArgs(argv) {
  const args = {
    corpus: process.env.WHETSTONE_PDF_CORPUS ?? null,
    rangeSize: DEFAULT_RANGE_SIZE,
    out: null
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--range-size") {
      args.rangeSize = Math.max(1, Number.parseInt(argv[(i += 1)], 10) || DEFAULT_RANGE_SIZE);
    } else if (argv[i] === "--out") {
      args.out = argv[(i += 1)] ?? null;
    } else {
      rest.push(argv[i]);
    }
  }
  if (args.corpus === null && rest.length > 0) args.corpus = rest[0];
  return args;
}

function resolvePython() {
  for (const command of ["python", "python3"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) return command;
  }
  return null;
}

// Sample the child's resident memory while it runs and return the peak in bytes, or null when the
// platform does not expose another process's RSS cheaply (no extra dependency is added for it).
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
    return 0; // win32: not sampled.
  };
  const loop = async () => {
    while (!stopped) {
      peak = Math.max(peak, readRssBytes());
      await delay(MEMORY_SAMPLE_MS);
    }
  };
  const sampled = process.platform === "linux" || process.platform === "darwin";
  const done = sampled ? loop() : Promise.resolve();
  return {
    async stop() {
      stopped = true;
      await done;
      return sampled ? peak : null;
    }
  };
}

// Run one worker invocation, sampling peak memory. Resolves { code, stdout, peakBytes }.
function runWorker(python, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(python, [WORKER, ...args]);
    const sampler = startPeakRssSampler(child.pid);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.on("close", async (code) => {
      const peakBytes = await sampler.stop();
      resolvePromise({ code: code ?? 1, stdout, peakBytes });
    });
  });
}

function finish(start, peakBytes, resultClass, pages, schemaVersion) {
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    pages,
    elapsedMs: Math.round(elapsedMs),
    peakMemoryMib: peakBytes > 0 ? Math.round(peakBytes / (1024 * 1024)) : null,
    resultClass,
    schemaVersion
  };
}

async function probeOne(python, pdfPath, rangeSize) {
  const start = process.hrtime.bigint();
  let peakBytes = 0;

  const probe = await runWorker(python, ["--probe", pdfPath]);
  peakBytes = Math.max(peakBytes, probe.peakBytes ?? 0);
  if (probe.code !== 0) {
    return finish(start, peakBytes, EXIT_NAMES[probe.code] ?? "unknown", null, null);
  }
  let pageCount = 0;
  try {
    pageCount = JSON.parse(probe.stdout).pageCount;
  } catch {
    return finish(start, peakBytes, "malformed", null, null);
  }

  let schemaVersion = null;
  for (let startPage = 1; startPage <= pageCount; startPage += rangeSize) {
    const endPage = Math.min(startPage + rangeSize - 1, pageCount);
    const range = await runWorker(python, ["--range", pdfPath, String(startPage), String(endPage)]);
    peakBytes = Math.max(peakBytes, range.peakBytes ?? 0);
    if (range.code !== 0) {
      return finish(start, peakBytes, EXIT_NAMES[range.code] ?? "unknown", pageCount, null);
    }
    try {
      schemaVersion = JSON.parse(range.stdout).doclingSchema?.version ?? schemaVersion;
    } catch {
      return finish(start, peakBytes, "malformed", pageCount, null);
    }
  }
  return finish(start, peakBytes, "ok", pageCount, schemaVersion);
}

function listPdfs(dir) {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function emit(out, record) {
  const line = JSON.stringify(record);
  if (out) appendFileSync(out, line + "\n");
  else process.stdout.write(line + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.corpus) {
    process.stderr.write(
      "usage: node scripts/probes/pdfStructuredCorpusProbe.mjs <corpus-dir> " +
        "[--range-size N] [--out file.jsonl]\n"
    );
    return 2;
  }
  const python = resolvePython();
  if (python === null) {
    process.stderr.write("Python 3 not found; run `pnpm setup:pdf` to enable the PDF lane.\n");
    return 3;
  }

  let pdfs;
  try {
    pdfs = listPdfs(args.corpus);
  } catch (cause) {
    process.stderr.write(
      `could not read corpus directory: ${cause instanceof Error ? cause.message : String(cause)}\n`
    );
    return 1;
  }

  const byResult = {};
  let index = 0;
  for (const pdfPath of pdfs) {
    index += 1;
    const metrics = await probeOne(python, pdfPath, args.rangeSize);
    byResult[metrics.resultClass] = (byResult[metrics.resultClass] ?? 0) + 1;
    // `index` only — never the file name or any content.
    emit(args.out, { index, ...metrics });
  }
  emit(args.out, { summary: true, files: index, byResult });
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
