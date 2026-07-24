import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS,
  parseRangeConversion,
  type RangeConversion
} from "@whetstone/contracts";
import { classifyOcrRouting } from "@whetstone/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureOcrTransformAdapter,
  ocrTransformFixture,
  resolvePdfOcrAdapter,
  type PdfOcrAdapterResolution
} from "./pdfOcrRunnerResolution.js";
import { issueStagedFileHandle, STRUCTURED_PDF_FIXTURE_MARKER } from "./pdfStructuredAdapter.js";

const supportedVersion = SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS[0]!;
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function textItem(pageNumber: number, text: string) {
  return {
    label: "text" as const,
    pageNumber,
    boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
    charSpan: [0, text.length] as [number, number],
    confidence: 1,
    text,
    children: []
  };
}

function fixtureWith(pages: readonly { pageNumber: number; hasNativeText: boolean }[]): RangeConversion {
  const nativeBody = pages
    .filter((p) => p.hasNativeText)
    .map((p) => textItem(p.pageNumber, `native page ${p.pageNumber}`));
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema: { name: "DoclingDocument", version: supportedVersion },
    pages: pages.map((p) => ({ pageNumber: p.pageNumber, hasNativeText: p.hasNativeText })),
    body: nativeBody,
    furniture: []
  } as RangeConversion;
}

async function stageFixture(fixture: RangeConversion): Promise<ReturnType<typeof issueStagedFileHandle>> {
  const stageRoot = await makeDir("whetstone-ocr-res-src-");
  const handle = issueStagedFileHandle(stageRoot, "source.pdf");
  await writeFile(handle.path, `%PDF-1.7\n${STRUCTURED_PDF_FIXTURE_MARKER}\n${JSON.stringify(fixture)}`);
  return handle;
}

describe("ocrTransformFixture", () => {
  it("flips exactly the text-less pages to native and injects one recovered item per flipped page", () => {
    const fixture = fixtureWith([
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: false }
    ]);

    const transformed = ocrTransformFixture(fixture, [2]);

    expect(transformed.pages).toEqual([
      { pageNumber: 1, hasNativeText: true },
      { pageNumber: 2, hasNativeText: true }
    ]);
    // The born-digital page's item is untouched; exactly one recovered item is added, for the flipped page.
    expect(transformed.body).toHaveLength(fixture.body.length + 1);
    const injected = transformed.body.filter((item) => item.text.includes("Recovered English text"));
    expect(injected).toHaveLength(1);
    expect(injected[0]?.pageNumber).toBe(2);
  });
});

describe("createFixtureOcrTransformAdapter", () => {
  it("OCRs a text-less page from the embedded fixture into published-ready native text", async () => {
    const source = await stageFixture(fixtureWith([{ pageNumber: 1, hasNativeText: false }]));
    const outputStageRoot = await makeDir("whetstone-ocr-res-out-");
    const workDirRoot = await makeDir("whetstone-ocr-res-work-");
    const adapter = createFixtureOcrTransformAdapter({ outputStageRoot, workDirRoot });

    const outcome = await adapter.execute({
      source,
      routing: classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]),
      language: "en"
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.result.output.stageRoot).toBe(outputStageRoot);
    expect(outcome.result.fingerprint.tesseractLanguage).toBe("eng");
    // The derived bytes are themselves a valid fixture whose page is now native and carries recovered text.
    const derived = parseRangeConversion(
      (await readFile(outcome.result.output.path, "utf8")).split(STRUCTURED_PDF_FIXTURE_MARKER)[1]!.trim()
    );
    if (derived.status !== "ok") throw new Error("expected a valid derived fixture");
    expect(derived.value.pages[0]?.hasNativeText).toBe(true);
    expect(derived.value.body.some((item) => item.text.includes("Recovered English text"))).toBe(true);
  });

  it("behaves like a missing tool when the staged bytes carry no embedded fixture", async () => {
    const stageRoot = await makeDir("whetstone-ocr-res-nofix-");
    const handle = issueStagedFileHandle(stageRoot, "source.pdf");
    await writeFile(handle.path, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const adapter = createFixtureOcrTransformAdapter({ outputStageRoot: await makeDir("whetstone-ocr-res-out-") });

    const outcome = await adapter.execute({
      source: handle,
      routing: classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]),
      language: "en"
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("tool_missing");
  });

  it("behaves like a missing tool when the staged bytes carry an unparseable fixture", async () => {
    // The marker is present but its payload is not a valid RangeConversion, so the loader returns null and
    // the pass fails visibly rather than transforming garbage.
    const stageRoot = await makeDir("whetstone-ocr-res-bad-");
    const handle = issueStagedFileHandle(stageRoot, "source.pdf");
    await writeFile(handle.path, `%PDF-1.7\n${STRUCTURED_PDF_FIXTURE_MARKER}\n{ not a conversion }`);
    const adapter = createFixtureOcrTransformAdapter({ outputStageRoot: await makeDir("whetstone-ocr-res-out-") });

    const outcome = await adapter.execute({
      source: handle,
      routing: classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]),
      language: "en"
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("tool_missing");
  });

  it("behaves like a missing tool when the staged source file is absent", async () => {
    // The before-probe's readFile throws for a handle whose bytes were never written, which the loader
    // swallows as "no fixture" rather than crashing the pass.
    const stageRoot = await makeDir("whetstone-ocr-res-absent-");
    const handle = issueStagedFileHandle(stageRoot, "missing.pdf");
    const adapter = createFixtureOcrTransformAdapter({ outputStageRoot: await makeDir("whetstone-ocr-res-out-") });

    const outcome = await adapter.execute({
      source: handle,
      routing: classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]),
      language: "en"
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("tool_missing");
  });
});

describe("resolvePdfOcrAdapter", () => {
  const base: PdfOcrAdapterResolution = {
    fixtureOcr: false,
    probe: { probe: () => Promise.reject(new Error("unused")) },
    ocrBinary: "ocrmypdf",
    tesseractBinary: "tesseract",
    timeoutMs: 1000,
    outputStageRoot: "/unused"
  };

  it("selects the staged-bytes fixture OCR lane when fixtureOcr is enabled", async () => {
    const outputStageRoot = await makeDir("whetstone-ocr-res-fx-");
    const source = await stageFixture(fixtureWith([{ pageNumber: 1, hasNativeText: false }]));
    const adapter = resolvePdfOcrAdapter({ ...base, fixtureOcr: true, outputStageRoot });

    const outcome = await adapter.execute({
      source,
      routing: classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]),
      language: "en"
    });
    // Only the input-derived fixture lane produces a success here; the real/unavailable lanes could not.
    expect(outcome.ok).toBe(true);
  });

  it("fails visibly on a platform where the memory ceiling cannot be enforced", async () => {
    const source = await stageFixture(fixtureWith([{ pageNumber: 1, hasNativeText: false }]));
    const adapter = resolvePdfOcrAdapter({ ...base, platform: "win32" });

    const outcome = await adapter.execute({
      source,
      routing: classifyOcrRouting([{ pageNumber: 1, hasNativeText: false }]),
      language: "en"
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("tool_missing");
  });

  it("constructs the real bounded adapter on a platform that can enforce the ceiling", () => {
    const adapter = resolvePdfOcrAdapter({ ...base, platform: "linux" });
    expect(typeof adapter.execute).toBe("function");
  });

  it("defaults to the host platform when none is injected", () => {
    const adapter = resolvePdfOcrAdapter(base);
    expect(typeof adapter.execute).toBe("function");
  });
});
