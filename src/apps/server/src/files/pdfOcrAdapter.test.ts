import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProbePage } from "@whetstone/contracts";
import { classifyOcrRouting, type OcrRoutingDecision } from "@whetstone/domain";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { OcrmypdfInvocation, OcrmypdfRunResult } from "./pdfOcr.js";
import {
  buildOcrFingerprint,
  buildOcrmypdfArgs,
  createFixturePdfOcrAdapter,
  createOcrmypdfPass,
  createPdfOcrAdapter,
  createUnavailablePdfOcrAdapter,
  formatOcrPageSelection,
  routingMatchesProbe,
  type PdfOcrOutcome,
  type PdfOcrRequest,
  type PdfPageProbe
} from "./pdfOcrAdapter.js";
import { createOcrToolchainInspector } from "./pdfOcrToolchain.js";
import {
  issueStagedFileHandle,
  type ProbeOutcome,
  type StagedFileHandle
} from "./pdfStructuredAdapter.js";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// Stage real source bytes under a server-issued handle, as the import job (#745) will.
async function stageSource(bytes: Uint8Array): Promise<StagedFileHandle> {
  const stageRoot = await makeTempDir("whetstone-ocr-src-");
  const handle = issueStagedFileHandle(stageRoot, "source.pdf");
  await writeFile(handle.path, bytes);
  return handle;
}

function page(
  pageNumber: number,
  hasNativeText: boolean,
  geometry: { width?: number; height?: number; rotation?: number } = {}
): ProbePage {
  return {
    pageNumber,
    width: geometry.width ?? 612,
    height: geometry.height ?? 792,
    rotation: geometry.rotation ?? 0,
    hasNativeText
  };
}

const SOURCE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);

function scannedRouting(): OcrRoutingDecision {
  return classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]);
}

function baseRequest(source: StagedFileHandle, routing: OcrRoutingDecision): PdfOcrRequest {
  return { source, routing, language: "en" };
}

function expectFailure(outcome: PdfOcrOutcome, kind: string): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a failure outcome");
  expect(outcome.failure.kind).toBe(kind);
  expect(outcome.failure.what.length).toBeGreaterThan(0);
  expect(outcome.failure.remedy.length).toBeGreaterThan(0);
}

describe("formatOcrPageSelection", () => {
  it("collapses ascending page numbers into OCRmyPDF range syntax", () => {
    expect(formatOcrPageSelection([])).toBe("");
    expect(formatOcrPageSelection([1])).toBe("1");
    expect(formatOcrPageSelection([1, 2, 3])).toBe("1-3");
    expect(formatOcrPageSelection([2, 4])).toBe("2,4");
    expect(formatOcrPageSelection([1, 3, 4, 6, 7, 8])).toBe("1,3-4,6-8");
  });
});

describe("buildOcrmypdfArgs", () => {
  it("uses the exact maintained options: one job, plain PDF, no lossy/clean/deskew/PDF-A", () => {
    const args = buildOcrmypdfArgs({
      inputPath: "/in.pdf",
      outputPath: "/out.pdf",
      tesseractLanguage: "eng",
      pageNumbersNeedingOcr: [2]
    });
    expect(args).toEqual([
      "--jobs",
      "1",
      "--output-type",
      "pdf",
      "--optimize",
      "0",
      "--skip-text",
      "-l",
      "eng",
      "--pages",
      "2",
      "/in.pdf",
      "/out.pdf"
    ]);
    expect(args).not.toContain("--clean");
    expect(args).not.toContain("--deskew");
    expect(args).not.toContain("pdfa");
  });
});

describe("buildOcrFingerprint", () => {
  it("pins the engine/versions and derives the Tesseract language + packs for English", () => {
    expect(buildOcrFingerprint("en")).toEqual({
      engine: "ocrmypdf",
      ocrmypdfVersion: "16.10.4",
      tesseractVersion: "5.5.1",
      language: "en",
      tesseractLanguage: "eng",
      languagePacks: ["eng"]
    });
  });

  it("pairs a Chinese script model with English", () => {
    const fingerprint = buildOcrFingerprint("zh-CN");
    expect(fingerprint.tesseractLanguage).toBe("chi_sim+eng");
    expect(fingerprint.languagePacks).toEqual(["chi_sim", "eng"]);
  });
});

describe("routingMatchesProbe", () => {
  it("accepts a routing whose OCR pages equal the probe's text-less pages", () => {
    const probeClassification = [
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ];
    expect(routingMatchesProbe(classifyOcrRouting(probeClassification), probeClassification)).toBe(
      true
    );
  });

  it("rejects a native routing for a source the probe classifies as scanned", () => {
    const probeClassification = [{ pageNumber: 1, hasNativeText: false }];
    const staleNative = classifyOcrRouting([{ pageNumber: 1, hasNativeText: true }]);
    expect(routingMatchesProbe(staleNative, probeClassification)).toBe(false);
  });

  it("rejects a routing that omits a probed text-less page (different page count)", () => {
    const probeClassification = [
      { pageNumber: 1, hasNativeText: false },
      { pageNumber: 2, hasNativeText: false }
    ];
    const partial = classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]);
    expect(routingMatchesProbe(partial, probeClassification)).toBe(false);
  });

  it("rejects a routing that targets a different page than the probe (same count)", () => {
    const probeClassification = [
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ];
    const wrongPage = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: false },
      { pageNumber: 2, hasNativeText: true }
    ]);
    expect(routingMatchesProbe(wrongPage, probeClassification)).toBe(false);
  });
});

describe("createOcrmypdfPass", () => {
  it("drives the shared spawn with the built argv, forwarding the timeout and signal", async () => {
    const invocations: OcrmypdfInvocation[] = [];
    const run = vi.fn((invocation: OcrmypdfInvocation): Promise<OcrmypdfRunResult> => {
      invocations.push(invocation);
      return Promise.resolve({ status: "ok" });
    });
    const controller = new AbortController();
    const pass = createOcrmypdfPass("ocrmypdf", run);

    const result = await pass({
      inputPath: "/in.pdf",
      outputPath: "/out.pdf",
      tesseractLanguage: "eng",
      pageNumbersNeedingOcr: [1, 2],
      timeoutMs: 30_000,
      signal: controller.signal
    });

    expect(result).toEqual({ status: "ok" });
    expect(invocations[0]).toEqual({
      binary: "ocrmypdf",
      args: buildOcrmypdfArgs({
        inputPath: "/in.pdf",
        outputPath: "/out.pdf",
        tesseractLanguage: "eng",
        pageNumbersNeedingOcr: [1, 2]
      }),
      timeoutMs: 30_000,
      signal: controller.signal
    });
  });

  it("omits the signal when none is supplied", async () => {
    const invocations: OcrmypdfInvocation[] = [];
    const run = vi.fn((invocation: OcrmypdfInvocation): Promise<OcrmypdfRunResult> => {
      invocations.push(invocation);
      return Promise.resolve({ status: "ok" });
    });
    const pass = createOcrmypdfPass("ocrmypdf", run);
    await pass({
      inputPath: "/in.pdf",
      outputPath: "/out.pdf",
      tesseractLanguage: "eng",
      pageNumbersNeedingOcr: [1],
      timeoutMs: 1000
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).not.toHaveProperty("signal");
  });
});

describe("createPdfOcrAdapter — success", () => {
  it("runs a scanned pass and returns a caller-owned validated output stage, source untouched", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({ outputStageRoot });

    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    expect(outcome.result.routingKind).toBe("scanned");
    expect(outcome.result.pagesOcred).toEqual([1]);
    expect(outcome.result.fingerprint.tesseractLanguage).toBe("eng");
    // The output handle is server-issued (unforgeable) and points inside the caller-owned stage.
    expect(outcome.result.output.stageRoot).toBe(outputStageRoot);
    expect(outcome.result.output.path.startsWith(outputStageRoot)).toBe(true);
    const output = new Uint8Array(await readFile(outcome.result.output.path));
    expect(output).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]));
    // The immutable source is not mutated.
    expect(new Uint8Array(await readFile(source.path))).toEqual(SOURCE_BYTES);
  });

  it("copies the source without OCR when routing is native (no text-less pages)", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const ocrPass = vi.fn();
    const nativePages = [page(1, true)];
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      before: nativePages,
      after: nativePages
    });
    // Native routing carries no pages to OCR.
    const routing = classifyOcrRouting([{ pageNumber: 1, hasNativeText: true }]);

    const outcome = await adapter.execute({ source, routing, language: "en" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.result.routingKind).toBe("native");
    expect(outcome.result.pagesOcred).toEqual([]);
    // The output is a faithful copy of the source bytes.
    expect(new Uint8Array(await readFile(outcome.result.output.path))).toEqual(SOURCE_BYTES);
    expect(ocrPass).not.toHaveBeenCalled();
  });

  it("OCRs only the text-less pages for a mixed document", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const pages = [page(1, true), page(2, false)];
    const adapter = createFixturePdfOcrAdapter({ outputStageRoot, before: pages, after: pages });
    const routing = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ]);

    const outcome = await adapter.execute({ source, routing, language: "en" });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.result.routingKind).toBe("mixed");
    expect(outcome.result.pagesOcred).toEqual([2]);
  });

  it("forwards a live abort signal into the OCR pass and stages the result under a chosen name", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const controller = new AbortController();
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      generateStagedName: () => "chosen-output.pdf"
    });

    const outcome = await adapter.execute({
      source,
      routing: scannedRouting(),
      language: "en",
      signal: controller.signal
    });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.result.output.path.endsWith("chosen-output.pdf")).toBe(true);
  });
});

describe("createPdfOcrAdapter — availability and validation failures", () => {
  it("fails as tool_missing when the toolchain is unavailable, before any probe/pass", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createUnavailablePdfOcrAdapter({ outputStageRoot });
    expectFailure(await adapter.execute(baseRequest(source, scannedRouting())), "tool_missing");
  });

  it("never runs a per-import `ocrmypdf --version` gate; the real inspector only lists Tesseract packs and the actual OCR pass runs (#797)", async () => {
    // The bug: a per-import `ocrmypdf --version` readiness probe could exceed its own 15s budget on a slow
    // OCRmyPDF cold start and reject the import as unresponsive, so the authoritative bounded OCR pass —
    // which would have succeeded — never ran. This wires the REAL toolchain inspector (via a recording
    // tool-probe seam) into the adapter and proves runtime never probes OCRmyPDF's `--version`, checks the
    // Tesseract language packs, and then does invoke the actual OCR pass, which is the source of truth.
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");

    // Records every tool invocation the inspector performs. A version gate would spawn `ocrmypdf --version`
    // here; it must not. The only sanctioned diagnostic is `tesseract --list-langs` for the pack check.
    const probedCommands: string[] = [];
    const inspectToolchain = createOcrToolchainInspector({
      tesseractBinary: "tesseract",
      probe: (binary, args) => {
        probedCommands.push(`${binary} ${args.join(" ")}`);
        return Promise.resolve({
          outcome: "exit",
          code: 0,
          output: "List of available languages (1):\neng\n"
        });
      }
    });

    // The authoritative bounded OCR pass: a deterministic success that records that it actually ran — the
    // operation the redundant diagnostic gate was pre-empting.
    let actualOcrPassCalls = 0;
    const ocrPass = createOcrmypdfPass("synthetic-ocrmypdf", async () => {
      actualOcrPassCalls += 1;
      return { status: "ok" };
    });

    const adapter = createPdfOcrAdapter({
      probe: {
        probe: () =>
          Promise.resolve<ProbeOutcome>({
            status: "ok",
            pageCount: 1,
            pages: [page(1, false)]
          })
      },
      inspectToolchain,
      // Write the output bytes only when the actual pass reports success, so ownership transfer is real.
      ocrPass: async (params) => {
        const result = await ocrPass(params);
        if (result.status === "ok") {
          await writeFile(params.outputPath, SOURCE_BYTES);
        }
        return result;
      },
      timeoutMs: 1000,
      outputStageRoot
    });

    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));

    expect(outcome.ok).toBe(true);
    // The actual bounded OCR operation ran — it was never pre-empted by a diagnostic gate.
    expect(actualOcrPassCalls).toBe(1);
    // Runtime consulted ONLY `tesseract --list-langs`; it never probed OCRmyPDF's `--version`.
    expect(probedCommands).toEqual(["tesseract --list-langs"]);
    expect(probedCommands.some((command) => command.includes("--version"))).toBe(false);
    expect(probedCommands.some((command) => command.includes("ocrmypdf"))).toBe(false);
  });

  it("fails a fixture configured with ocrmypdfAvailable:false as tool_missing", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({ outputStageRoot, ocrmypdfAvailable: false });
    expectFailure(await adapter.execute(baseRequest(source, scannedRouting())), "tool_missing");
  });

  it("fails as language_missing when a required Tesseract pack is not installed", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      installedTraineddata: ["eng"] // zh-CN needs chi_sim + eng
    });
    const outcome = await adapter.execute({
      source,
      routing: scannedRouting(),
      language: "zh-CN"
    });
    expectFailure(outcome, "language_missing");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("chi_sim");
  });

  it("refuses a handle that was not issued by the server", async () => {
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({ outputStageRoot });
    const forged = { path: "/etc/passwd", stageRoot: "/etc" } as unknown as StagedFileHandle;
    expectFailure(
      await adapter.execute(baseRequest(forged, scannedRouting())),
      "unsupported_input"
    );
  });

  it("maps a failing OCR pass to its named failure (input-file exit -> unsupported_input)", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      passResult: { status: "exit", code: 2, signal: null }
    });
    expectFailure(
      await adapter.execute(baseRequest(source, scannedRouting())),
      "unsupported_input"
    );
  });

  it("maps a tool_missing pass result to tool_missing", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      passResult: { status: "tool_missing" }
    });
    expectFailure(await adapter.execute(baseRequest(source, scannedRouting())), "tool_missing");
  });

  it("maps a tool_missing BEFORE-probe to tool_missing", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      beforeProbe: { status: "tool_missing" }
    });
    expectFailure(await adapter.execute(baseRequest(source, scannedRouting())), "tool_missing");
  });

  it("maps a malformed BEFORE-probe to unsupported_input, carrying the detail", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      beforeProbe: { status: "malformed", detail: "broken xref" }
    });
    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));
    expectFailure(outcome, "unsupported_input");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("broken xref");
  });

  it("maps a password-required BEFORE-probe to unsupported_input", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      beforeProbe: { status: "password_required" } as ProbeOutcome
    });
    expectFailure(
      await adapter.execute(baseRequest(source, scannedRouting())),
      "unsupported_input"
    );
  });

  it("maps a non-ok AFTER-probe to output_validation", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      afterProbe: { status: "malformed", detail: "unreadable output" }
    });
    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));
    expectFailure(outcome, "output_validation");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("unreadable output");
  });

  it("maps a tool_missing AFTER-probe to output_validation with the status", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      afterProbe: { status: "tool_missing" }
    });
    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));
    expectFailure(outcome, "output_validation");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("tool_missing");
  });

  it("rejects a pass that altered page geometry", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      before: [page(1, false, { rotation: 0 })],
      after: [page(1, false, { rotation: 90 })]
    });
    expectFailure(await adapter.execute(baseRequest(source, scannedRouting())), "geometry");
  });

  it("rejects a pass that dropped native text on a page", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      before: [page(1, true), page(2, false)],
      after: [page(1, false), page(2, false)]
    });
    const routing = classifyOcrRouting([
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ]);
    expectFailure(await adapter.execute({ source, routing, language: "en" }), "native_text");
  });

  it("surfaces a cleanup failure after an otherwise successful pass", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      removeWorkingDir: () => Promise.reject(new Error("EACCES: temp busy"))
    });
    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));
    expectFailure(outcome, "cleanup");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("EACCES");
    // The validated output was still transferred to the caller-owned stage.
    expect((await stat(outputStageRoot)).isDirectory()).toBe(true);
  });

  it("stringifies a non-Error cleanup cause", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      removeWorkingDir: () => Promise.reject("temp volume vanished")
    });
    const outcome = await adapter.execute(baseRequest(source, scannedRouting()));
    expectFailure(outcome, "cleanup");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("temp volume vanished");
  });

  it("keeps a real failure's kind even when cleanup also fails", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      passResult: { status: "exit", code: 2, signal: null },
      removeWorkingDir: () => Promise.reject(new Error("EACCES"))
    });
    // The pass failure (unsupported_input) keeps priority over the cleanup failure.
    expectFailure(
      await adapter.execute(baseRequest(source, scannedRouting())),
      "unsupported_input"
    );
  });

  it("returns output_validation when the working directory cannot be created", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      // A workDirRoot whose parent does not exist makes mkdtemp reject.
      workDirRoot: join(tmpdir(), `whetstone-missing-${randomUUID()}`, "nested")
    });
    expectFailure(
      await adapter.execute(baseRequest(source, scannedRouting())),
      "output_validation"
    );
  });

  it("returns output_validation when the pass step throws (missing source on a native copy)", async () => {
    const stageRoot = await makeTempDir("whetstone-ocr-src-");
    // A server-issued handle to a file that does not exist: the native copy throws.
    const source = issueStagedFileHandle(stageRoot, "missing.pdf");
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const nativePages = [page(1, true)];
    const adapter = createFixturePdfOcrAdapter({
      outputStageRoot,
      before: nativePages,
      after: nativePages
    });
    const routing = classifyOcrRouting([{ pageNumber: 1, hasNativeText: true }]);
    expectFailure(await adapter.execute({ source, routing, language: "en" }), "output_validation");
  });
});

describe("createPdfOcrAdapter — cancellation", () => {
  it("returns cancelled without inspecting the toolchain when already aborted", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const inspectToolchain = vi.fn();
    const adapter = createPdfOcrAdapter({
      probe: { probe: () => Promise.reject(new Error("unused")) },
      inspectToolchain,
      ocrPass: () => Promise.reject(new Error("unused")),
      timeoutMs: 1000,
      outputStageRoot
    });
    const outcome = await adapter.execute({
      source,
      routing: scannedRouting(),
      language: "en",
      signal: AbortSignal.abort()
    });
    expectFailure(outcome, "cancelled");
    expect(inspectToolchain).not.toHaveBeenCalled();
  });

  it("returns cancelled if the signal aborts during the before-probe", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const controller = new AbortController();
    const okPages: ProbePage[] = [page(1, false)];
    const probe: PdfPageProbe = {
      probe: () => {
        controller.abort();
        return Promise.resolve<ProbeOutcome>({
          status: "ok",
          pageCount: 1,
          pages: okPages
        });
      }
    };
    const ocrPass = vi.fn();
    const adapter = createPdfOcrAdapter({
      probe,
      inspectToolchain: () =>
        Promise.resolve({ status: "available", installedTraineddata: ["eng"] }),
      ocrPass,
      timeoutMs: 1000,
      outputStageRoot
    });
    const outcome = await adapter.execute({
      source,
      routing: scannedRouting(),
      language: "en",
      signal: controller.signal
    });
    expectFailure(outcome, "cancelled");
    // The pass never ran because cancellation was observed right after the before-probe.
    expect(ocrPass).not.toHaveBeenCalled();
  });
});

describe("createPdfOcrAdapter — routing must match the fresh before-probe", () => {
  // A probe seam that always classifies the source (and its OCR output) as the given pages, and records
  // how many times it ran, so a mismatch can be shown to fail BEFORE the OCR pass and output staging.
  function fixedProbe(pages: ProbePage[]): PdfPageProbe {
    return {
      probe: () => Promise.resolve<ProbeOutcome>({ status: "ok", pageCount: pages.length, pages })
    };
  }

  it("rejects a stale native routing for a source the probe classifies as scanned, never OCRing or staging it", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const ocrPass = vi.fn();
    const adapter = createPdfOcrAdapter({
      // The immutable source is scanned (page 1 text-less), so it MUST be OCR'd.
      probe: fixedProbe([page(1, false)]),
      inspectToolchain: () =>
        Promise.resolve({ status: "available", installedTraineddata: ["eng"] }),
      ocrPass,
      timeoutMs: 1000,
      outputStageRoot
    });

    // The caller hands a stale/mismatched `native` decision (no pages to OCR) for this scanned source.
    const staleNative = classifyOcrRouting([{ pageNumber: 1, hasNativeText: true }]);
    const outcome = await adapter.execute({ source, routing: staleNative, language: "en" });

    expectFailure(outcome, "routing_mismatch");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failure.what).toContain("scanned");
    // The mismatch is caught before running or copying: no OCR pass, and nothing was staged.
    expect(ocrPass).not.toHaveBeenCalled();
    expect(await readdir(outputStageRoot)).toEqual([]);
    // The immutable source is untouched.
    expect(new Uint8Array(await readFile(source.path))).toEqual(SOURCE_BYTES);
  });

  it("rejects a routing that omits a page the probe classifies as text-less", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    const ocrPass = vi.fn();
    const adapter = createPdfOcrAdapter({
      // Pages 1 and 2 both lack native text; both must be OCR'd.
      probe: fixedProbe([page(1, false), page(2, false)]),
      inspectToolchain: () =>
        Promise.resolve({ status: "available", installedTraineddata: ["eng"] }),
      ocrPass,
      timeoutMs: 1000,
      outputStageRoot
    });

    // The caller's decision only covers page 1 — page 2 would silently never be OCR'd.
    const partial = classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]);
    const outcome = await adapter.execute({ source, routing: partial, language: "en" });

    expectFailure(outcome, "routing_mismatch");
    expect(ocrPass).not.toHaveBeenCalled();
    expect(await readdir(outputStageRoot)).toEqual([]);
  });

  it("reports the probe-derived kind and pages even if the caller's decision labels them differently", async () => {
    const source = await stageSource(SOURCE_BYTES);
    const outputStageRoot = await makeTempDir("whetstone-ocr-out-");
    // The probe sees a mixed source: page 1 native, page 2 text-less.
    const pages = [page(1, true), page(2, false)];
    const adapter = createFixturePdfOcrAdapter({ outputStageRoot, before: pages, after: pages });
    // The caller supplies a routing whose pages agree ([2]) but whose kind is mislabelled `scanned`.
    const mislabelled: OcrRoutingDecision = {
      kind: "scanned",
      pageNumbersNeedingOcr: [2],
      nativePageCount: 0,
      ocrPageCount: 1
    };

    const outcome = await adapter.execute({ source, routing: mislabelled, language: "en" });
    if (!outcome.ok) throw new Error("expected success");
    // The reported kind is derived from the probe, not trusted from the caller's mislabel.
    expect(outcome.result.routingKind).toBe("mixed");
    expect(outcome.result.pagesOcred).toEqual([2]);
  });
});
