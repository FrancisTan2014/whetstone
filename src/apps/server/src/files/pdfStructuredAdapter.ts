import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  concatenateRanges,
  MAX_PAGE_COUNT,
  MAX_STAGED_BYTES,
  parseProbeClassification,
  parseRangeConversion,
  type ProbePage,
  type RangeConversion,
  type StructuredDocument,
  type StructuredPage
} from "@whetstone/contracts";
import {
  cancelledFailure,
  classifyWorkerExit,
  cleanupFailure,
  forbiddenHandleFailure,
  malformedFailure,
  passwordRequiredFailure,
  toolMissingFailure,
  tooLargeFailure,
  tooManyPagesFailure,
  unsupportedSchemaFailure,
  type PdfStructuredFailure
} from "./pdfStructuredErrors.js";
import { resolveWithinDirectory } from "./sourceFileStore.js";

// The bounded structured PDF adapter (#701): a born-digital PDF staged by the server is converted, one
// conversion at a time and under explicit resource bounds, into ONE validated structured-document
// result. Format-specific code (Docling, page geometry, child processes) ends here; the adapter never
// creates a Work, a Reader branch, or a PDF content model. There is no consumer yet — #721 owns the
// stage lifecycle and is the first caller.

// A server-issued reference to staged bytes. Only the server constructs it (via issueStagedFileHandle
// from a name it generated), so the adapter never accepts a user-supplied path and cannot be steered
// outside the stage directory. #721 owns the stage's creation and removal; #701 only reads through it.
//
// The handle is UNFORGEABLE at the module boundary: it carries a module-private witness symbol that
// only `issueStagedFileHandle` can stamp. A caller cannot name the symbol, so it cannot build a
// conforming literal (compile time); and `convert` re-checks the witness at runtime, so a handle cast
// past the type (e.g. `{ path, stageRoot } as StagedFileHandle`) is refused before any filesystem read.
const stagedFileHandleWitness: unique symbol = Symbol("whetstone.pdf.stagedFileHandle");

export type StagedFileHandle = Readonly<{
  path: string;
  stageRoot: string;
  readonly [stagedFileHandleWitness]: true;
}>;

// True only for a handle stamped by `issueStagedFileHandle`. Read defensively (a forged value has no
// such property at runtime, so the declared `true` type must not short-circuit the check).
export function isServerIssued(handle: StagedFileHandle): boolean {
  return (handle as unknown as Record<symbol, unknown>)[stagedFileHandleWitness] === true;
}

// A simple server-issued name only (letters, digits, dot, hyphen, underscore); never `.`/`..` and
// never a path with separators. Resolved within the stage root so a crafted name cannot escape it.
const safeStagedNamePattern = /^[A-Za-z0-9_.-]+$/;

export function issueStagedFileHandle(stageRoot: string, stagedName: string): StagedFileHandle {
  if (stagedName === "." || stagedName === ".." || !safeStagedNamePattern.test(stagedName)) {
    throw new Error("Staged file name must be a simple, server-issued name without path segments.");
  }
  const path = resolveWithinDirectory(stageRoot, stagedName);
  return Object.freeze({
    path,
    stageRoot: resolve(stageRoot),
    [stagedFileHandleWitness]: true as const
  });
}

export type ProbeOutcome =
  | Readonly<{ status: "ok"; pageCount: number; pages: readonly ProbePage[] }>
  | Readonly<{ status: "password_required" }>
  | Readonly<{ status: "tool_missing" }>
  | Readonly<{ status: "malformed"; detail: string }>;

// Default page box (US Letter, no rotation) for a probe outcome that has only per-page native-text
// (the in-memory fake and the staged-fixture backend do not carry real page geometry). The real
// worker `--probe` supplies real geometry; these deterministic backends only need consistent, valid
// geometry so the shared probe shape stays uniform.
const DEFAULT_PROBE_PAGE_GEOMETRY = Object.freeze({ width: 612, height: 792, rotation: 0 });

// Project a structured page's native-text flag onto the shared probe-page shape with default geometry.
function probePageFrom(page: StructuredPage): ProbePage {
  return Object.freeze({
    pageNumber: page.pageNumber,
    ...DEFAULT_PROBE_PAGE_GEOMETRY,
    hasNativeText: page.hasNativeText
  });
}

export type RangeRunOutcome =
  | Readonly<{ status: "ok"; raw: string }>
  | Readonly<{ status: "failure"; failure: PdfStructuredFailure }>;

// The private conversion boundary. The real implementation spawns the isolated Python/Docling child;
// the fake is pure in-memory. Both keep Docling objects and real I/O out of the adapter, which only
// orchestrates bounds, ranges, ordering, cancellation, and validation.
export interface DoclingRunner {
  probe(pdfPath: string, signal: AbortSignal | undefined): Promise<ProbeOutcome>;
  convertRange(
    pdfPath: string,
    startPage: number,
    endPage: number,
    signal: AbortSignal | undefined
  ): Promise<RangeRunOutcome>;
}

export type ConvertOptions = Readonly<{ signal?: AbortSignal }>;

export type StructuredConversionOutcome =
  | Readonly<{ ok: true; document: StructuredDocument }>
  | Readonly<{ ok: false; failure: PdfStructuredFailure }>;

export interface PdfStructuredAdapter {
  convert(handle: StagedFileHandle, options?: ConvertOptions): Promise<StructuredConversionOutcome>;
}

export type AdapterLimits = Readonly<{
  maxStagedBytes: number;
  maxPageCount: number;
  pageRangeSize: number;
}>;

const defaultLimits: AdapterLimits = Object.freeze({
  maxStagedBytes: MAX_STAGED_BYTES,
  maxPageCount: MAX_PAGE_COUNT,
  pageRangeSize: 50
});

export type PdfStructuredAdapterDependencies = Readonly<{
  runner: DoclingRunner;
  limits?: Partial<AdapterLimits>;
  tempDir?: string;
  // Injected so the "temp cleanup failed" path is testable; defaults to a recursive force remove.
  removeWorkingDir?: (dir: string) => Promise<void>;
}>;

// Split [1..pageCount] into contiguous, source-ordered ranges of at most `size` pages each.
export function pageRangesFor(
  pageCount: number,
  size: number
): readonly Readonly<{ startPage: number; endPage: number }>[] {
  const ranges: Array<{ startPage: number; endPage: number }> = [];
  for (let startPage = 1; startPage <= pageCount; startPage += size) {
    ranges.push({ startPage, endPage: Math.min(startPage + size - 1, pageCount) });
  }
  return ranges;
}

function ok(document: StructuredDocument): StructuredConversionOutcome {
  return { ok: true, document };
}

function fail(failure: PdfStructuredFailure): StructuredConversionOutcome {
  return { ok: false, failure };
}

// A single place to describe a thrown/rejected value. fs and the runner reject with an Error; the
// String() arm is the defensive path for a non-Error rejection (e.g. a runner that rejects a string).
function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createPdfStructuredAdapter(
  dependencies: PdfStructuredAdapterDependencies
): PdfStructuredAdapter {
  const limits: AdapterLimits = { ...defaultLimits, ...dependencies.limits };
  const tempDir = dependencies.tempDir ?? tmpdir();
  const removeWorkingDir =
    dependencies.removeWorkingDir ?? ((dir: string) => rm(dir, { force: true, recursive: true }));

  // Single-flight: chain every conversion so exactly one runs at a time, regardless of caller
  // concurrency. `convertUnlocked` provably never rejects (every failure is returned as data), so the
  // tail stays a resolved promise and one conversion can never block the next.
  let tail: Promise<unknown> = Promise.resolve();
  function runExclusive(
    work: () => Promise<StructuredConversionOutcome>
  ): Promise<StructuredConversionOutcome> {
    const result = tail.then(work);
    tail = result.then(() => undefined);
    return result;
  }

  async function convertUnlocked(
    handle: StagedFileHandle,
    signal: AbortSignal | undefined
  ): Promise<StructuredConversionOutcome> {
    // Refuse any handle that was not issued by the server BEFORE touching the filesystem, so a forged
    // or cast handle can never steer a read to an arbitrary path (path/data-integrity first).
    if (!isServerIssued(handle)) {
      return fail(forbiddenHandleFailure());
    }

    if (signal?.aborted === true) {
      return fail(cancelledFailure());
    }

    // Bound the size from the file's stat first, so an oversized stage is rejected without reading its
    // bytes into memory. A stat failure (missing/unreadable stage) is a malformed input, not a crash.
    let byteLength: number;
    try {
      byteLength = (await stat(handle.path)).size;
    } catch (cause) {
      return fail(malformedFailure(`staged file could not be read: ${causeMessage(cause)}`));
    }
    if (byteLength > limits.maxStagedBytes) {
      return fail(tooLargeFailure(byteLength, limits.maxStagedBytes));
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(handle.path);
    } catch (cause) {
      return fail(malformedFailure(`staged bytes could not be read: ${causeMessage(cause)}`));
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    let dir: string;
    try {
      dir = await mkdtemp(join(tempDir, "whetstone-pdf-structured-"));
    } catch (cause) {
      return fail(
        malformedFailure(`could not create a conversion working directory: ${causeMessage(cause)}`)
      );
    }

    const workPath = join(dir, "staged.pdf");
    let outcome: StructuredConversionOutcome;
    try {
      await writeFile(workPath, bytes);
      outcome = await runConversion(workPath, { sha256, byteLength: bytes.byteLength }, signal);
    } catch (cause) {
      // The runner or working-copy write threw unexpectedly (a programming/environment fault, not an
      // expected failure mode). Keep the public contract — resolve with a named failure, not a reject.
      outcome = fail(malformedFailure(`the conversion could not be run: ${causeMessage(cause)}`));
    }
    // Cleanup is best-effort but VISIBLE: if the working files cannot be removed after an otherwise
    // successful conversion, surface it as a cleanup failure (a real failure keeps priority).
    return cleanup(dir, outcome);
  }

  async function cleanup(
    dir: string,
    outcome: StructuredConversionOutcome
  ): Promise<StructuredConversionOutcome> {
    try {
      await removeWorkingDir(dir);
      return outcome;
    } catch (cause) {
      const detail = causeMessage(cause);
      return outcome.ok ? fail(cleanupFailure(detail)) : outcome;
    }
  }

  async function runConversion(
    workPath: string,
    source: Readonly<{ sha256: string; byteLength: number }>,
    signal: AbortSignal | undefined
  ): Promise<StructuredConversionOutcome> {
    const probe = await dependencies.runner.probe(workPath, signal);
    if (probe.status === "tool_missing") {
      return fail(toolMissingFailure());
    }
    if (probe.status === "password_required") {
      return fail(passwordRequiredFailure());
    }
    if (probe.status === "malformed") {
      return fail(malformedFailure(probe.detail));
    }
    if (probe.pageCount > limits.maxPageCount) {
      return fail(tooManyPagesFailure(probe.pageCount, limits.maxPageCount));
    }

    const ranges: RangeConversion[] = [];
    for (const { startPage, endPage } of pageRangesFor(probe.pageCount, limits.pageRangeSize)) {
      if (signal?.aborted === true) {
        return fail(cancelledFailure());
      }
      const run = await dependencies.runner.convertRange(workPath, startPage, endPage, signal);
      if (run.status === "failure") {
        return fail(run.failure);
      }
      const parsed = parseRangeConversion(run.raw);
      if (parsed.status === "malformed") {
        return fail(malformedFailure(parsed.detail));
      }
      if (parsed.status === "unsupported_schema") {
        return fail(unsupportedSchemaFailure(parsed.version));
      }
      ranges.push(parsed.value);
    }

    return ok(
      concatenateRanges(
        { sha256: source.sha256, byteLength: source.byteLength, pageCount: probe.pageCount },
        ranges
      )
    );
  }

  return Object.freeze({
    convert(
      handle: StagedFileHandle,
      options?: ConvertOptions
    ): Promise<StructuredConversionOutcome> {
      return runExclusive(() => convertUnlocked(handle, options?.signal));
    }
  });
}

// Deterministic in-memory runner: canned probe + range payloads, no Python or models. Backs the shared
// contract suite and the adapter/runner unit tests only — it ignores the staged bytes, so it is NEVER
// the production conversion backend (that would publish canned content from any upload). A configured
// `failRangeWith` or probe override exercises the adapter's failure branches without a real child process.
export type FakeDoclingRunnerConfig = Readonly<{
  probe?: ProbeOutcome;
  // Raw JSON string(s) the runner returns per range, in order. When shorter than the range list, the
  // last payload repeats. Ignored when `failRangeWith` is set.
  rangePayloads?: readonly string[];
  failRangeWith?: PdfStructuredFailure;
  // Observers so the contract suite can assert single-flight and cancellation propagation.
  onActive?: (active: number) => void;
}>;

export function createFakeDoclingRunner(config: FakeDoclingRunnerConfig = {}): DoclingRunner {
  const probe: ProbeOutcome = config.probe ?? {
    status: "ok",
    pageCount: 1,
    pages: [probePageFrom({ pageNumber: 1, hasNativeText: true })]
  };
  let active = 0;
  let rangeIndex = 0;

  function enter(): void {
    active += 1;
    config.onActive?.(active);
  }
  function leave(): void {
    active -= 1;
  }

  return Object.freeze({
    probe(): Promise<ProbeOutcome> {
      enter();
      try {
        return Promise.resolve(probe);
      } finally {
        leave();
      }
    },
    convertRange(): Promise<RangeRunOutcome> {
      enter();
      try {
        if (config.failRangeWith !== undefined) {
          return Promise.resolve({ status: "failure", failure: config.failRangeWith });
        }
        const payloads = config.rangePayloads ?? [defaultRangePayload()];
        const raw = payloads[Math.min(rangeIndex, payloads.length - 1)]!;
        rangeIndex += 1;
        return Promise.resolve({ status: "ok", raw });
      } finally {
        leave();
      }
    }
  });
}

// A valid single-page range payload used by the default fake — one native-text page with a
// low-confidence unknown-label item, so the contract suite can prove nothing is dropped.
export function defaultRangePayload(): string {
  return JSON.stringify({
    schemaVersion: "whetstone-pdf-structured-range/1",
    doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
    pages: [{ pageNumber: 1, hasNativeText: true }],
    body: [
      {
        label: "section_header",
        pageNumber: 1,
        boundingBox: { left: 0, top: 0, right: 100, bottom: 20 },
        charSpan: [0, 5],
        confidence: 0.98,
        text: "Title",
        children: []
      },
      {
        label: "some_unknown_label",
        pageNumber: 1,
        boundingBox: { left: 0, top: 20, right: 100, bottom: 40 },
        charSpan: [5, 12],
        confidence: 0.12,
        text: "unsure.",
        children: []
      }
    ],
    furniture: []
  });
}

// Convenience wrapper: the deterministic fake adapter (adapter + fake runner). Requires no Python.
export function createFakePdfStructuredAdapter(
  config?: FakeDoclingRunnerConfig,
  limits?: Partial<AdapterLimits>
): PdfStructuredAdapter {
  return createPdfStructuredAdapter({
    runner: createFakeDoclingRunner(config),
    ...(limits ? { limits } : {})
  });
}

// The production fallback when no structured PDF converter is available on this host — an unsupported
// platform where the per-child memory ceiling cannot be enforced (see `createDoclingRunner`), or a
// toolchain that is simply not selected. Every attempt FAILS VISIBLY with `tool_missing`, the same
// honest signal the real runner reports when Python/Docling is absent, so a user upload is never
// silently turned into fabricated content. `pnpm setup:pdf` provisions the real converter.
export function createUnavailableDoclingRunner(): DoclingRunner {
  return Object.freeze({
    probe(): Promise<ProbeOutcome> {
      return Promise.resolve({ status: "tool_missing" });
    },
    convertRange(): Promise<RangeRunOutcome> {
      return Promise.resolve({ status: "failure", failure: toolMissingFailure() });
    }
  });
}

// The marker separating a deterministic conversion fixture from any leading PDF header bytes in a
// staged upload the fixture runner reads.
export const STRUCTURED_PDF_FIXTURE_MARKER = "%%WHETSTONE-PDF-FIXTURE%%";

// The dev/test structured conversion backend (NOT a production default). Unlike the in-memory fake, it
// reads the ACTUAL staged bytes and converts them: a caller embeds a valid RangeConversion after the
// `%%WHETSTONE-PDF-FIXTURE%%` marker in the uploaded file, and the runner projects exactly those bytes.
// This keeps the born-digital E2E honest — a different upload yields a different Work, and a fixture page
// with `hasNativeText: false` flows through to the OCR-required outcome — while never fabricating canned
// content: bytes with no embedded fixture (a real PDF on a host without the Docling worker) report
// `tool_missing`, exactly like the unavailable runner. Gated on `PDF_IMPORT_FIXTURE_CONVERSION`; never
// enabled in production.
export function createStagedFixtureDoclingRunner(): DoclingRunner {
  async function loadFixture(pdfPath: string): Promise<RangeConversion | null> {
    let text: string;
    try {
      text = await readFile(pdfPath, "utf8");
    } catch {
      return null;
    }
    const markerAt = text.indexOf(STRUCTURED_PDF_FIXTURE_MARKER);
    if (markerAt < 0) {
      return null;
    }
    const parsed = parseRangeConversion(
      text.slice(markerAt + STRUCTURED_PDF_FIXTURE_MARKER.length).trim()
    );
    return parsed.status === "ok" ? parsed.value : null;
  }

  return Object.freeze({
    async probe(pdfPath: string): Promise<ProbeOutcome> {
      const fixture = await loadFixture(pdfPath);
      return fixture === null
        ? { status: "tool_missing" }
        : {
            status: "ok",
            pageCount: fixture.pages.length,
            pages: fixture.pages.map(probePageFrom)
          };
    },
    async convertRange(
      pdfPath: string,
      startPage: number,
      endPage: number
    ): Promise<RangeRunOutcome> {
      const fixture = await loadFixture(pdfPath);
      if (fixture === null) {
        return { status: "failure", failure: toolMissingFailure() };
      }
      // Project only the requested page window, so a multi-range fixture never re-emits earlier pages.
      const inWindow = (pageNumber: number): boolean =>
        pageNumber >= startPage && pageNumber <= endPage;
      const windowed: RangeConversion = {
        ...fixture,
        pages: fixture.pages.filter((page) => inWindow(page.pageNumber)),
        body: fixture.body.filter((item) => inWindow(item.pageNumber))
      };
      return { status: "ok", raw: JSON.stringify(windowed) };
    }
  });
}

export type DoclingRunnerDependencies = Readonly<{
  pythonBinary: string;
  scriptPath: string;
  perRangeTimeoutMs: number;
  memoryMib: number;
  // Injected so the platform fence is testable; defaults to the host platform.
  platform?: NodeJS.Platform;
}>;

const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;

// The worker enforces the per-child memory ceiling with POSIX `resource.setrlimit(RLIMIT_AS)`. Windows
// has no equivalent the child can self-apply, so the #701 memory-bounded invariant cannot be met
// there. Rather than run the real adapter memory-unbounded, the real runner is fenced off: it refuses
// to construct on a platform where the ceiling cannot be enforced. The deterministic fake adapter is
// pure in-memory and stays available on every platform for tests and #721's keyless default.
export function canEnforceStructuredPdfMemoryCeiling(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

// The real runner: spawn the isolated Python worker, one child per operation, bounded by the
// per-range time ceiling (execFile kills on timeout) and a memory ceiling the worker self-applies.
// The child is terminated on success, failure, timeout, or cancellation. All real spawning is
// coverage-ignored: it needs a live Python/Docling install, exercised only by the skip-guarded real
// lane; every decision it delegates to (classifyWorkerExit, parseProbePageCount, parseRangeConversion)
// is unit-tested.
export function createDoclingRunner(dependencies: DoclingRunnerDependencies): DoclingRunner {
  // Fence the real adapter off where the memory ceiling cannot be enforced (see the predicate above),
  // BEFORE any spawning, so an unsupported platform gets an honest "unavailable" instead of a
  // memory-unbounded conversion. Checked outside the coverage-ignored region so the fence is tested.
  const platform = dependencies.platform ?? process.platform;
  if (!canEnforceStructuredPdfMemoryCeiling(platform)) {
    throw new Error(
      `The structured PDF adapter requires a per-child memory ceiling, which cannot be enforced on ` +
        `platform "${platform}". Run it on a POSIX platform (Linux/macOS) where the worker can apply ` +
        `an address-space rlimit.`
    );
  }
  /* v8 ignore start -- real subprocess boundary; covered only by the skip-guarded real lane */
  function spawn(
    args: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<{ stdout: string } | { failure: PdfStructuredFailure }> {
    return new Promise((resolvePromise) => {
      const child = execFile(
        dependencies.pythonBinary,
        [dependencies.scriptPath, ...args],
        {
          env: { ...process.env, WHETSTONE_PDF_MEMORY_MIB: String(dependencies.memoryMib) },
          killSignal: "SIGKILL",
          maxBuffer: MAX_WORKER_OUTPUT_BYTES,
          signal,
          timeout: dependencies.perRangeTimeoutMs
        },
        (error, stdout) => {
          if (error === null) {
            resolvePromise({ stdout });
            return;
          }
          const withMeta = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals;
          };
          if (withMeta.code === "ENOENT") {
            resolvePromise({ failure: toolMissingFailure() });
            return;
          }
          const cancelled = signal?.aborted === true;
          const timedOut = withMeta.killed === true && !cancelled;
          resolvePromise({
            failure: classifyWorkerExit({
              code: typeof withMeta.code === "number" ? withMeta.code : null,
              signal: withMeta.signal ?? null,
              timedOut,
              cancelled,
              timeoutMs: dependencies.perRangeTimeoutMs
            })
          });
        }
      );
      child.on("error", () => undefined);
    });
  }

  async function probe(pdfPath: string, signal: AbortSignal | undefined): Promise<ProbeOutcome> {
    const result = await spawn(["--probe", pdfPath], signal);
    if ("failure" in result) {
      if (result.failure.kind === "tool_missing") {
        return { status: "tool_missing" };
      }
      if (result.failure.kind === "password_required") {
        return { status: "password_required" };
      }
      return { status: "malformed", detail: result.failure.what };
    }
    const parsed = parseProbeClassification(result.stdout);
    return parsed.status === "ok"
      ? { status: "ok", pageCount: parsed.pageCount, pages: parsed.pages }
      : { status: "malformed", detail: parsed.detail };
  }

  async function convertRange(
    pdfPath: string,
    startPage: number,
    endPage: number,
    signal: AbortSignal | undefined
  ): Promise<RangeRunOutcome> {
    const result = await spawn(["--range", pdfPath, String(startPage), String(endPage)], signal);
    return "failure" in result
      ? { status: "failure", failure: result.failure }
      : { status: "ok", raw: result.stdout };
  }
  /* v8 ignore stop */

  return Object.freeze({ probe, convertRange });
}
