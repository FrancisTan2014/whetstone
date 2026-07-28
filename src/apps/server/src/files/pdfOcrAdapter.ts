import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProbePage } from "@whetstone/contracts";
import {
  classifyOcrRouting,
  ocrTesseractLanguage,
  requiredTesseractTraineddata,
  validateNativeTextPreserved,
  validateOcrGeometry,
  type OcrPageClassification,
  type OcrPageGeometry,
  type OcrRoutingDecision,
  type OcrRoutingKind,
  type WorkLanguage
} from "@whetstone/domain";

import { runOcrmypdf, type OcrmypdfRunResult, type RunOcrmypdf } from "./pdfOcr.js";
import {
  classifyOcrmypdfFailure,
  ocrCleanupFailure,
  ocrGeometryFailure,
  ocrLanguageMissingFailure,
  ocrNativeTextFailure,
  ocrOutputValidationFailure,
  ocrRoutingMismatchFailure,
  ocrToolMissingFailure,
  ocrToolUnresponsiveFailure,
  ocrUnsupportedInputFailure,
  type PdfOcrFailure
} from "./pdfOcrErrors.js";
import {
  isServerIssued,
  issueStagedFileHandle,
  type ProbeOutcome,
  type StagedFileHandle
} from "./pdfStructuredAdapter.js";

// The bounded PDF OCR adapter (#755). OCR tool and file mechanics stop at THIS server-file boundary: an
// import job (#745, the first consumer) supplies a server-issued source stage, #704's routing decision,
// and a resolved language; the adapter runs one bounded OCRmyPDF pre-pass, validates that it preserved
// source geometry / rotation / native text, and returns a caller-owned validated output stage or a
// typed failure. It owns no job/database/publication state and never mutates the immutable original.
//
// Three implementations pass the same shape contract: the real adapter (drives the shared OCRmyPDF
// spawn seam), a deterministic fixture (no installed tools or network), and an unavailable adapter
// (always tool_missing). All keep real process/Python objects private behind injected seams.

// The private worker boundary used to probe page geometry / rotation / native text before and after the
// OCR pass. Structurally satisfied by the structured adapter's `DoclingRunner`, so the same validated
// probe (#744 probe extension) classifies both — no second probe implementation.
export interface PdfPageProbe {
  probe(pdfPath: string, signal: AbortSignal | undefined): Promise<ProbeOutcome>;
}

// What the toolchain inspection reports so the adapter can fail fast with a NAMED tool/language error
// before spawning. A readiness-probe timeout or launch failure is NOT the same as an absent executable
// (#788): collapsing both into "unavailable" made the UI instruct the user to install a tool that is
// already installed. So the inspection is a discriminated outcome — `available` with the installed
// Tesseract packs, `missing` when the executable genuinely cannot be found (ENOENT), or `unresponsive`
// when a present OCRmyPDF failed its bounded readiness probe (a slow cold start / timeout, a launch
// failure, or a non-zero `--version`). Injected — the consumer knows the provisioned environment; the
// fixture/unavailable lanes supply canned values with no subprocess.
export type OcrReadinessFailureReason = "timeout" | "launch_failure" | "version_probe_failed";

export type OcrToolchainAvailability =
  | Readonly<{ status: "available"; installedTraineddata: readonly string[] }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "unresponsive"; reason: OcrReadinessFailureReason; detail: string }>;

export type InspectOcrToolchain = () => Promise<OcrToolchainAvailability>;

// The engine/version/language-pack fingerprint recorded with a successful pass. Versions are the pinned
// toolchain (`pnpm setup:pdf` provisions exactly these); the language packs are derived from the
// resolved Work language via #704's pure policy, so the fingerprint is deterministic.
export type OcrFingerprint = Readonly<{
  engine: "ocrmypdf";
  ocrmypdfVersion: string;
  tesseractVersion: string;
  language: WorkLanguage;
  tesseractLanguage: string;
  languagePacks: readonly string[];
}>;

export type PdfOcrRequest = Readonly<{
  // A server-issued staged handle to the immutable source PDF. Unforgeable at the type level and
  // re-checked at runtime, so the adapter can never be steered to read an arbitrary server path.
  source: StagedFileHandle;
  // #704's routing decision: which pages lack native text (only those are OCR'd).
  routing: OcrRoutingDecision;
  // The already-resolved Work language the pass runs in (drives the Tesseract `-l` value and packs).
  language: WorkLanguage;
  signal?: AbortSignal;
}>;

export type PdfOcrResult = Readonly<{
  // A fresh caller-owned staged handle to the validated OCR output. Ownership transfers only after full
  // validation; the source stage is untouched.
  output: StagedFileHandle;
  fingerprint: OcrFingerprint;
  routingKind: OcrRoutingKind;
  pagesOcred: readonly number[];
}>;

export type PdfOcrOutcome =
  | Readonly<{ ok: true; result: PdfOcrResult }>
  | Readonly<{ ok: false; failure: PdfOcrFailure }>;

export interface PdfOcrAdapter {
  execute(request: PdfOcrRequest): Promise<PdfOcrOutcome>;
}

// The OCR pass seam: run OCRmyPDF over `inputPath`, writing the OCR'd PDF to `outputPath`, and return
// the raw run result. The real pass builds the exact argv and drives the shared spawn; the fixture pass
// writes deterministic bytes with no subprocess.
export type OcrPassParams = Readonly<{
  inputPath: string;
  outputPath: string;
  tesseractLanguage: string;
  pageNumbersNeedingOcr: readonly number[];
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type OcrPass = (params: OcrPassParams) => Promise<OcrmypdfRunResult>;

// Collapse an ascending, de-duplicated page-number list into OCRmyPDF's `--pages` syntax
// ("1-3,5,8-9"), so the pass touches only the classified text-less pages. Pure and total.
export function formatOcrPageSelection(pageNumbers: readonly number[]): string {
  const ranges: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const page of pageNumbers) {
    if (start === undefined || previous === undefined) {
      start = page;
      previous = page;
      continue;
    }
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  if (start !== undefined && previous !== undefined) {
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  }
  return ranges.join(",");
}

// The exact, maintained OCRmyPDF argv for a bounded pass: one CPU job, plain PDF output (never PDF/A),
// lossy recompression disabled, native-text pages skipped, only the classified text-less pages
// selected. Cleanup and deskew stay off by simply not being requested (both default off). Pure, so the
// "exact command options" contract is asserted without a subprocess.
export function buildOcrmypdfArgs(params: {
  inputPath: string;
  outputPath: string;
  tesseractLanguage: string;
  pageNumbersNeedingOcr: readonly number[];
}): string[] {
  return [
    "--jobs",
    "1",
    "--output-type",
    "pdf",
    "--optimize",
    "0",
    "--skip-text",
    "-l",
    params.tesseractLanguage,
    "--pages",
    formatOcrPageSelection(params.pageNumbersNeedingOcr),
    params.inputPath,
    params.outputPath
  ];
}

// Build the real OCR pass from the OCRmyPDF binary and the shared spawn seam. This is the ONLY place
// that turns a pass request into an OCRmyPDF invocation; it adds no spawn of its own.
export function createOcrmypdfPass(binary: string, run: RunOcrmypdf = runOcrmypdf): OcrPass {
  return (params: OcrPassParams) =>
    run({
      binary,
      args: buildOcrmypdfArgs(params),
      timeoutMs: params.timeoutMs,
      ...(params.signal === undefined ? {} : { signal: params.signal })
    });
}

// The pinned OCR toolchain the adapter records in its reported fingerprint. OCRmyPDF (MPL-2.0) drives
// Tesseract (Apache-2.0) — permissive tools only. These are the MINIMUM versions the fingerprint
// reports so a stale toolchain is visible rather than silently trusted. They live here in the OCR
// adapter's own scope (not the #744 probe contract slice, which deliberately dropped them) because the
// adapter is the only consumer; kept as product pins asserted by tests, not style tokens.
export const PINNED_OCRMYPDF_VERSION = "16.10.4";
export const PINNED_TESSERACT_VERSION = "5.5.1";

// The engine/version/language-pack fingerprint for a resolved language, from the pinned versions and
// #704's pure language policy. Pure and exported so it is asserted directly.
export function buildOcrFingerprint(language: WorkLanguage): OcrFingerprint {
  return Object.freeze({
    engine: "ocrmypdf",
    ocrmypdfVersion: PINNED_OCRMYPDF_VERSION,
    tesseractVersion: PINNED_TESSERACT_VERSION,
    language,
    tesseractLanguage: ocrTesseractLanguage(language),
    languagePacks: requiredTesseractTraineddata(language)
  });
}

// The compact, deterministic string persisted on an attempt's `ocr_fingerprint` column when a validated
// OCR stage is adopted (#745). Non-null is the recovery boundary; the value also identifies the exact
// engine/versions/language every produced block carries as per-block OCR evidence. Pure and exported so
// the store adoption, publication block-evidence, and tests share one format.
export function formatOcrFingerprint(fingerprint: OcrFingerprint): string {
  return [
    `${fingerprint.engine}@${fingerprint.ocrmypdfVersion}`,
    `tesseract@${fingerprint.tesseractVersion}`,
    fingerprint.tesseractLanguage
  ].join("/");
}

const OCR_OUTPUT_FILENAME = "ocr-output.pdf";

function toGeometry(pages: readonly ProbePage[]): OcrPageGeometry[] {
  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    rotation: page.rotation
  }));
}

function toClassification(pages: readonly ProbePage[]): OcrPageClassification[] {
  return pages.map((page) => ({ pageNumber: page.pageNumber, hasNativeText: page.hasNativeText }));
}

// Whether two ascending, de-duplicated page-number selections are identical. Pure and total.
function samePageSelection(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((page, index) => page === right[index]);
}

// Whether a caller-supplied routing decision (#704) agrees with the routing the adapter re-derives from
// its OWN fresh before-probe classification. #704's decision is computed upstream from the structured
// conversion; before it is trusted to decide which pages are (or are not) OCR'd, the adapter compares
// the pages it would OCR against the pages the probe just classified as text-less. They must be the
// exact same set — otherwise a stale/mismatched decision (e.g. `native` for a source the probe
// classifies as scanned) could copy the original, still pass the geometry/native-text checks, and
// report a text-less page as validated OCR without ever OCRing it. Pure and total.
export function routingMatchesProbe(
  routing: OcrRoutingDecision,
  probeClassification: readonly OcrPageClassification[]
): boolean {
  return samePageSelection(
    routing.pageNumbersNeedingOcr,
    classifyOcrRouting(probeClassification).pageNumbersNeedingOcr
  );
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Map a non-`ok` BEFORE probe to a named failure: an absent probe toolchain is tool_missing; any other
// non-ok status means the source could not be classified, so it is unsupported input.
function beforeProbeFailure(probe: Exclude<ProbeOutcome, { status: "ok" }>): PdfOcrFailure {
  return probe.status === "tool_missing"
    ? ocrToolMissingFailure()
    : ocrUnsupportedInputFailure(
        probe.status === "malformed"
          ? `source could not be probed: ${probe.detail}`
          : `source could not be probed (${probe.status})`
      );
}

export type PdfOcrAdapterDependencies = Readonly<{
  // Probe geometry/rotation/native-text before and after the pass (the private worker boundary).
  probe: PdfPageProbe;
  // Report toolchain/language-pack availability so tool/language failures are named before any spawn.
  inspectToolchain: InspectOcrToolchain;
  // Run the bounded OCR pass (real OCRmyPDF spawn, or a deterministic fixture writer).
  ocrPass: OcrPass;
  // Wall-clock ceiling for the OCR pass.
  timeoutMs: number;
  // The caller-owned directory a validated result is staged into (ownership transfers here).
  outputStageRoot: string;
  // The root under which the adapter creates its private working directory. Defaults to the OS temp dir.
  workDirRoot?: string;
  // Injected so the "temp cleanup failed" path is testable; defaults to a recursive force remove.
  removeWorkingDir?: (dir: string) => Promise<void>;
  // Injected so the staged output name is deterministic in tests; defaults to a random, path-safe name.
  generateStagedName?: () => string;
}>;

export function createPdfOcrAdapter(dependencies: PdfOcrAdapterDependencies): PdfOcrAdapter {
  const workDirRoot = dependencies.workDirRoot ?? tmpdir();
  const removeWorkingDir =
    dependencies.removeWorkingDir ?? ((dir: string) => rm(dir, { force: true, recursive: true }));
  const generateStagedName = dependencies.generateStagedName ?? (() => `${randomUUID()}.pdf`);

  function fail(failure: PdfOcrFailure): PdfOcrOutcome {
    return { ok: false, failure };
  }

  // Move the validated output out of the adapter-owned working dir into the caller-owned output stage,
  // transferring ownership. The output is copied into a fresh server-issued path; the working copy is
  // removed with the rest of the working dir during cleanup. Copy-then-cleanup (rather than a rename)
  // works uniformly whether or not the stage is on the same device.
  async function transferOwnership(outputPath: string): Promise<StagedFileHandle> {
    await mkdir(dependencies.outputStageRoot, { recursive: true });
    const handle = issueStagedFileHandle(dependencies.outputStageRoot, generateStagedName());
    await copyFile(outputPath, handle.path);
    return handle;
  }

  async function runValidatedPass(request: PdfOcrRequest, workDir: string): Promise<PdfOcrOutcome> {
    const outputPath = join(workDir, OCR_OUTPUT_FILENAME);

    const before = await dependencies.probe.probe(request.source.path, request.signal);
    if (before.status !== "ok") {
      return fail(beforeProbeFailure(before));
    }
    if (request.signal?.aborted === true) {
      return fail(classifyOcrmypdfFailure({ status: "cancelled" }, dependencies.timeoutMs));
    }

    // Re-derive routing from the adapter's OWN fresh probe and require the caller's decision to agree
    // before running or copying. This closes the trust gap where a stale/mismatched #704 decision — e.g.
    // `native` for a source this probe classifies as scanned — would copy the original, still pass the
    // geometry/native-text checks, and report a text-less page as validated OCR without OCRing it. The
    // probe-derived routing (never the unverified caller value) then drives the pass and the reported
    // kind/pages, so a page that does not exist or is already native can never be reported as OCR'd.
    const probeClassification = toClassification(before.pages);
    const probeRouting = classifyOcrRouting(probeClassification);
    if (!routingMatchesProbe(request.routing, probeClassification)) {
      return fail(
        ocrRoutingMismatchFailure(
          `the probe classifies the source as ${probeRouting.kind} (text-less pages [${probeRouting.pageNumbersNeedingOcr.join(", ")}]), but the routing decision is ${request.routing.kind} (OCR pages [${request.routing.pageNumbersNeedingOcr.join(", ")}]).`
        )
      );
    }

    const pageNumbersNeedingOcr = probeRouting.pageNumbersNeedingOcr;
    if (pageNumbersNeedingOcr.length === 0) {
      // Native routing: nothing to OCR. Produce a faithful copy so the caller still receives a
      // validated, owned output stage without rewriting a born-digital PDF.
      await copyFile(request.source.path, outputPath);
    } else {
      const run = await dependencies.ocrPass({
        inputPath: request.source.path,
        outputPath,
        tesseractLanguage: ocrTesseractLanguage(request.language),
        pageNumbersNeedingOcr,
        timeoutMs: dependencies.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      if (run.status !== "ok") {
        return fail(classifyOcrmypdfFailure(run, dependencies.timeoutMs));
      }
    }

    const after = await dependencies.probe.probe(outputPath, request.signal);
    if (after.status !== "ok") {
      return fail(
        ocrOutputValidationFailure(
          after.status === "malformed"
            ? after.detail
            : `the OCR output could not be re-probed (${after.status})`
        )
      );
    }

    const geometry = validateOcrGeometry(toGeometry(before.pages), toGeometry(after.pages));
    if (!geometry.ok) {
      return fail(ocrGeometryFailure(geometry.detail));
    }
    const nativeText = validateNativeTextPreserved(
      toClassification(before.pages),
      toClassification(after.pages)
    );
    if (!nativeText.ok) {
      return fail(ocrNativeTextFailure(nativeText.pageNumber));
    }

    const output = await transferOwnership(outputPath);
    return {
      ok: true,
      result: Object.freeze({
        output,
        fingerprint: buildOcrFingerprint(request.language),
        routingKind: probeRouting.kind,
        pagesOcred: Object.freeze([...pageNumbersNeedingOcr])
      })
    };
  }

  return Object.freeze({
    async execute(request: PdfOcrRequest): Promise<PdfOcrOutcome> {
      // Re-check the server witness at runtime so a handle cast past the type cannot steer a read.
      if (!isServerIssued(request.source)) {
        return fail(ocrUnsupportedInputFailure("the source handle was not issued by the server"));
      }
      if (request.signal?.aborted === true) {
        return fail(classifyOcrmypdfFailure({ status: "cancelled" }, dependencies.timeoutMs));
      }

      const toolchain = await dependencies.inspectToolchain();
      if (toolchain.status === "missing") {
        return fail(ocrToolMissingFailure());
      }
      if (toolchain.status === "unresponsive") {
        // Present-but-not-ready: never claim the tool is missing, and never offer the install remedy.
        return fail(ocrToolUnresponsiveFailure(toolchain.reason, toolchain.detail));
      }
      const missingPacks = requiredTesseractTraineddata(request.language).filter(
        (pack) => !toolchain.installedTraineddata.includes(pack)
      );
      if (missingPacks.length > 0) {
        return fail(ocrLanguageMissingFailure(missingPacks));
      }

      let workDir: string;
      try {
        workDir = await mkdtemp(join(workDirRoot, "whetstone-pdf-ocr-"));
      } catch (cause) {
        return fail(
          ocrOutputValidationFailure(
            `could not create an OCR working directory: ${causeMessage(cause)}`
          )
        );
      }

      let outcome: PdfOcrOutcome;
      try {
        outcome = await runValidatedPass(request, workDir);
      } catch (cause) {
        outcome = fail(
          ocrOutputValidationFailure(`the OCR pass could not be run: ${causeMessage(cause)}`)
        );
      }

      // Cleanup is best-effort but VISIBLE: after an otherwise successful pass, a failure to remove the
      // working directory is surfaced as a cleanup failure rather than hiding residue (a real failure
      // keeps priority).
      try {
        await removeWorkingDir(workDir);
        return outcome;
      } catch (cause) {
        return outcome.ok ? fail(ocrCleanupFailure(causeMessage(cause))) : outcome;
      }
    }
  });
}

// Deterministic fixture pages: one text-less page, US Letter, upright. The fixture lane validates the
// identical result contract with no installed OCR tools or network.
const DEFAULT_FIXTURE_PAGES: readonly ProbePage[] = Object.freeze([
  Object.freeze({ pageNumber: 1, width: 612, height: 792, rotation: 0, hasNativeText: false })
]);

const FIXTURE_OCR_OUTPUT_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

export type FixturePdfOcrConfig = Readonly<{
  outputStageRoot: string;
  timeoutMs?: number;
  workDirRoot?: string;
  ocrmypdfAvailable?: boolean;
  installedTraineddata?: readonly string[];
  // Geometry/native-text the fixture probe reports BEFORE and AFTER the pass. Default: identical, so
  // validation passes; override `after` to exercise the geometry/native-text failure paths.
  before?: readonly ProbePage[];
  after?: readonly ProbePage[];
  // The raw pass result the fixture returns; default a success that writes fixture output bytes.
  passResult?: OcrmypdfRunResult;
  outputBytes?: Uint8Array;
  // Non-ok probe outcomes to exercise the input/output validation paths.
  beforeProbe?: ProbeOutcome;
  afterProbe?: ProbeOutcome;
  removeWorkingDir?: (dir: string) => Promise<void>;
  generateStagedName?: () => string;
}>;

// A deterministic, tool-free OCR adapter for the fixture lane and boundary tests. It writes real temp
// bytes (so ownership transfer is genuinely exercised) but spawns nothing and needs no network.
export function createFixturePdfOcrAdapter(config: FixturePdfOcrConfig): PdfOcrAdapter {
  const before = config.before ?? DEFAULT_FIXTURE_PAGES;
  const after = config.after ?? before;
  const outputBytes = config.outputBytes ?? FIXTURE_OCR_OUTPUT_BYTES;
  const okProbe = (pages: readonly ProbePage[]): ProbeOutcome => ({
    status: "ok",
    pageCount: pages.length,
    pages
  });

  const probe: PdfPageProbe = {
    probe: (pdfPath: string) => {
      // The adapter probes the source first, then its own `ocr-output.pdf`; discriminate by that name.
      const isAfter = pdfPath.endsWith(OCR_OUTPUT_FILENAME);
      const outcome = isAfter
        ? (config.afterProbe ?? okProbe(after))
        : (config.beforeProbe ?? okProbe(before));
      return Promise.resolve(outcome);
    }
  };

  const ocrPass: OcrPass = async (params: OcrPassParams) => {
    const result = config.passResult ?? { status: "ok" };
    if (result.status === "ok") {
      await writeFile(params.outputPath, outputBytes);
    }
    return result;
  };

  return createPdfOcrAdapter({
    probe,
    inspectToolchain: () =>
      Promise.resolve<OcrToolchainAvailability>(
        (config.ocrmypdfAvailable ?? true)
          ? {
              status: "available",
              installedTraineddata: config.installedTraineddata ?? ["eng", "chi_sim", "chi_tra"]
            }
          : { status: "missing" }
      ),
    ocrPass,
    timeoutMs: config.timeoutMs ?? 60_000,
    outputStageRoot: config.outputStageRoot,
    ...(config.workDirRoot === undefined ? {} : { workDirRoot: config.workDirRoot }),
    ...(config.removeWorkingDir === undefined ? {} : { removeWorkingDir: config.removeWorkingDir }),
    ...(config.generateStagedName === undefined
      ? {}
      : { generateStagedName: config.generateStagedName })
  });
}

// The keyless/unprovisioned lane: no OCR toolchain, so every request fails as tool_missing before any
// spawn. Needs no probe or pass — a request is refused at the availability gate.
export function createUnavailablePdfOcrAdapter(
  config: Readonly<{ outputStageRoot: string; timeoutMs?: number }>
): PdfOcrAdapter {
  /* v8 ignore start -- the availability gate returns tool_missing before probe/pass are ever reached */
  const unreachable = (): never => {
    throw new Error("The unavailable OCR adapter has no probe or pass.");
  };
  /* v8 ignore stop */
  return createPdfOcrAdapter({
    probe: { probe: unreachable },
    inspectToolchain: () => Promise.resolve<OcrToolchainAvailability>({ status: "missing" }),
    ocrPass: unreachable,
    timeoutMs: config.timeoutMs ?? 60_000,
    outputStageRoot: config.outputStageRoot
  });
}

// Re-exported for a caller assembling a routing decision from a validated probe classification.
export { classifyOcrRouting };
