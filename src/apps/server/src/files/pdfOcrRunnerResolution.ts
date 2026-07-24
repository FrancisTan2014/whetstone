import { readFile, writeFile } from "node:fs/promises";

import {
  parseRangeConversion,
  type RangeConversion,
  type StructuredDocItem,
  type StructuredPage
} from "@whetstone/contracts";

import {
  createOcrmypdfPass,
  createPdfOcrAdapter,
  createUnavailablePdfOcrAdapter,
  type OcrPass,
  type OcrPassParams,
  type PdfOcrAdapter,
  type PdfPageProbe
} from "./pdfOcrAdapter.js";
import { createOcrToolchainInspector } from "./pdfOcrToolchain.js";
import {
  canEnforceStructuredPdfMemoryCeiling,
  STRUCTURED_PDF_FIXTURE_MARKER,
  type ProbeOutcome
} from "./pdfStructuredAdapter.js";

// Resolve the OCR backend the born-digital import worker (#745) drives for a scanned/mixed English PDF,
// honestly and absent-config-safe — the OCR twin of `resolveStructuredPdfRunner`. The composition root
// NEVER wires a canned in-memory OCR result: a scanned upload must either be OCR'd from its own bytes or
// fail visibly, never published as fabricated text.
//
// Three outcomes, in priority order:
//   1. Fixture OCR — only when `PDF_IMPORT_FIXTURE_OCR` is set (dev/E2E). It reads the ACTUAL staged
//      bytes' embedded conversion fixture and transforms the text-less pages into native pages carrying
//      recovered text, so the scanned/mixed English journey runs deterministically without an OCR tool
//      install. Off in production.
//   2. Real bounded adapter — on a platform where the structured worker's memory ceiling can be enforced
//      (the same platform fence, since the adapter re-probes via that worker). When the pinned OCR
//      toolchain is not provisioned it fails per attempt with a named tool/language error (fail
//      visibly), so nothing canned is ever published.
//   3. Unavailable adapter — on an unsupported platform (e.g. Windows) where the bounded real path
//      cannot run. Every attempt fails visibly with `tool_missing`.

// Default page box for a fixture-derived probe outcome (US Letter, upright). Identical before and after
// the transform, so the adapter's geometry validation passes; only the native-text flag changes.
const FIXTURE_PROBE_GEOMETRY = Object.freeze({ width: 612, height: 792, rotation: 0 });

// Read a `RangeConversion` embedded after the `%%WHETSTONE-PDF-FIXTURE%%` marker in a staged file, or
// null when the bytes carry no fixture. Mirrors the structured fixture runner's loader so the OCR
// fixture lane reads the same embedded document a fixture upload carries.
async function loadFixtureConversion(pdfPath: string): Promise<RangeConversion | null> {
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

// Serialize a transformed fixture back into staged bytes with the same header + marker shape a fixture
// upload uses, so the derived `ocr.pdf` is itself a valid fixture the structured runner then converts.
function encodeFixtureConversion(conversion: RangeConversion): Uint8Array {
  return new TextEncoder().encode(
    `%PDF-1.7\n${STRUCTURED_PDF_FIXTURE_MARKER}\n${JSON.stringify(conversion)}`
  );
}

// The recovered-text body item the fixture OCR injects for a page it flips to native, so the transformed
// page maps to a canonical block (an honest stand-in for text an OCR pass would add). Pure and total.
function recoveredTextItem(pageNumber: number): StructuredDocItem {
  const text = `Recovered English text from page ${pageNumber} via OCR.`;
  return Object.freeze({
    label: "text",
    pageNumber,
    boundingBox: Object.freeze({ left: 0, top: 0, right: 100, bottom: 20 }),
    charSpan: Object.freeze([0, text.length]) as readonly [number, number],
    confidence: 0.9,
    text,
    children: Object.freeze([]) as readonly StructuredDocItem[]
  });
}

// Transform an embedded conversion fixture as a deterministic OCR pass would: flip exactly the pages the
// routing classified as text-less to native, and inject one recovered-text item per flipped page so the
// page carries publishable content. Pages already native are untouched (a mixed document keeps its
// born-digital pages). Pure and total, so the E2E's "text appears after OCR" contract is asserted
// directly.
export function ocrTransformFixture(
  fixture: RangeConversion,
  pageNumbersNeedingOcr: readonly number[]
): RangeConversion {
  const flipped = new Set(pageNumbersNeedingOcr);
  const pages: readonly StructuredPage[] = fixture.pages.map((page) =>
    flipped.has(page.pageNumber) ? { pageNumber: page.pageNumber, hasNativeText: true } : page
  );
  const injected = fixture.pages
    .filter((page) => flipped.has(page.pageNumber))
    .map((page) => recoveredTextItem(page.pageNumber));
  return Object.freeze({
    ...fixture,
    pages,
    body: Object.freeze([...fixture.body, ...injected])
  });
}

// A deterministic, tool-free OCR adapter for the E2E fixture lane. It reads the source's embedded
// conversion fixture, transforms the text-less pages into native pages carrying recovered text, and
// writes that as the derived `ocr.pdf` fixture — so converting the OCR output honestly publishes English
// scanned/mixed content. Its probe reads whichever file it is handed (source before, output after), so
// the adapter's geometry / native-text / routing validation runs against real embedded fixtures.
export function createFixtureOcrTransformAdapter(
  config: Readonly<{ outputStageRoot: string; timeoutMs?: number; workDirRoot?: string }>
): PdfOcrAdapter {
  const probe: PdfPageProbe = {
    async probe(pdfPath: string): Promise<ProbeOutcome> {
      const fixture = await loadFixtureConversion(pdfPath);
      if (fixture === null) {
        return { status: "tool_missing" };
      }
      return {
        status: "ok",
        pageCount: fixture.pages.length,
        pages: fixture.pages.map((page) => ({
          pageNumber: page.pageNumber,
          ...FIXTURE_PROBE_GEOMETRY,
          hasNativeText: page.hasNativeText
        }))
      };
    }
  };

  const ocrPass: OcrPass = async (params: OcrPassParams) => {
    const fixture = await loadFixtureConversion(params.inputPath);
    if (fixture === null) {
      // No embedded fixture: behave like a missing tool rather than fabricate output.
      return { status: "tool_missing" };
    }
    const transformed = ocrTransformFixture(fixture, params.pageNumbersNeedingOcr);
    await writeFile(params.outputPath, encodeFixtureConversion(transformed));
    return { status: "ok" };
  };

  return createPdfOcrAdapter({
    probe,
    inspectToolchain: () =>
      Promise.resolve({ ocrmypdfAvailable: true, installedTraineddata: ["eng", "chi_sim", "chi_tra"] }),
    ocrPass,
    timeoutMs: config.timeoutMs ?? 60_000,
    outputStageRoot: config.outputStageRoot,
    ...(config.workDirRoot === undefined ? {} : { workDirRoot: config.workDirRoot })
  });
}

export type PdfOcrAdapterResolution = Readonly<{
  // Enable the deterministic staged-bytes fixture OCR lane (dev/E2E only). Never true in production.
  fixtureOcr: boolean;
  // The page probe the real adapter re-probes with (the resolved structured worker satisfies it).
  probe: PdfPageProbe;
  ocrBinary: string;
  tesseractBinary: string;
  timeoutMs: number;
  outputStageRoot: string;
  // Injected so platform selection is testable; defaults to the host platform.
  platform?: NodeJS.Platform;
}>;

export function resolvePdfOcrAdapter(resolution: PdfOcrAdapterResolution): PdfOcrAdapter {
  if (resolution.fixtureOcr) {
    return createFixtureOcrTransformAdapter({
      outputStageRoot: resolution.outputStageRoot,
      timeoutMs: resolution.timeoutMs
    });
  }

  const platform = resolution.platform ?? process.platform;
  if (!canEnforceStructuredPdfMemoryCeiling(platform)) {
    return createUnavailablePdfOcrAdapter({
      outputStageRoot: resolution.outputStageRoot,
      timeoutMs: resolution.timeoutMs
    });
  }

  return createPdfOcrAdapter({
    probe: resolution.probe,
    inspectToolchain: createOcrToolchainInspector({
      ocrmypdfBinary: resolution.ocrBinary,
      tesseractBinary: resolution.tesseractBinary
    }),
    ocrPass: createOcrmypdfPass(resolution.ocrBinary),
    timeoutMs: resolution.timeoutMs,
    outputStageRoot: resolution.outputStageRoot
  });
}
