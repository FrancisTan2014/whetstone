import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { PINNED_MODEL_COMMIT, PINNED_MODEL_REPO } from "@whetstone/contracts";

import {
  canEnforceStructuredPdfMemoryCeiling,
  createDoclingRunner,
  createPdfStructuredAdapter,
  issueStagedFileHandle
} from "./pdfStructuredAdapter.js";
import { createOcrmypdfPass } from "./pdfOcrAdapter.js";
import {
  defaultStructuredPdfMemoryMib,
  resolveStructuredPdfTimeoutMs
} from "../config/serverConfig.js";

// #789 real-toolchain regression. The bug: a smallest-scale scanned page completes the OCR pre-pass, but the
// structured Docling conversion of that OCR-derived page was killed by the born-digital-calibrated 180000 ms
// ceiling, so no Work published. The fix raised the single shared timeout owner
// (`resolveStructuredPdfTimeoutMs`) to 600000 ms. This test drives the REAL toolchain end to end on a
// generated, public, image-only PDF (no private corpus input), under the SAME production timeout the live
// import lane resolves, and asserts the OBSERVABLE outcome: a published, non-empty canonical conversion
// carrying the recovered scan text on a native-text page. It is the only test exercising the real
// OCR -> Docling -> publish path, so it guards that pipeline against regressing to a non-publishing state.
//
// The deterministic fail-before/pass-after on the recalibrated ceiling itself lives in the fast unit guard
// (serverConfig.test.ts: `resolveStructuredPdfTimeoutMs(undefined) === 600000`, strictly above the retired
// 180000). This real-lane test does NOT itself force a >180000 ms conversion — a smallest-scale page can
// finish well inside either bound on a fast host — so it validates the end-to-end budget and the published
// outcome on a provisioned host rather than reproducing the exact wall-clock kill from the field report.
//
// It is skip-guarded on the full real lane (a supported memory-boundary platform, an importable Docling with
// the pinned model snapshot cached, plus OCRmyPDF and Tesseract on PATH). CI does not provision that heavy
// toolchain, so it skips cleanly there; it runs on a provisioned host where the budget is validated.

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// A compact 5x7 uppercase/digit bitmap font (rows top->bottom, 5 bits/row, MSB = leftmost). Only the glyphs
// the deterministic scan text needs. Kept local to the test — it is generated evidence, not product logic.
const SCAN_FONT: Readonly<Record<string, readonly number[]>> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  A: [0x04, 0x0a, 0x11, 0x11, 0x1f, 0x11, 0x11],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  S: [0x0e, 0x11, 0x10, 0x0e, 0x01, 0x11, 0x0e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11]
};

const SCAN_MARKER = "WHETSTONE";
const SCAN_TEXT = "WHETSTONE SCAN TEST";

// Build a valid single-page, image-only PDF whose only page content is a rasterized bitmap of deterministic
// ASCII text (no text operators, so the page is genuinely scanned/image-only and takes the OCR lane). The
// raster is a DeviceGray image XObject, Flate-compressed with Node's built-in zlib — no new dependency.
function generateImageOnlyScanPdf(): Buffer {
  const scale = 6;
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const gap = 2 * scale;
  const margin = 40;
  const width = 1000;
  const height = 1400;
  const raster = Buffer.alloc(width * height, 0xff);

  const setPixel = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }
    raster[y * width + x] = 0x00;
  };
  const drawGlyph = (rows: readonly number[], ox: number, oy: number): void => {
    for (let ry = 0; ry < 7; ry += 1) {
      const bits = rows[ry] ?? 0;
      for (let rx = 0; rx < 5; rx += 1) {
        if (((bits >> (4 - rx)) & 1) === 0) {
          continue;
        }
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            setPixel(ox + rx * scale + sx, oy + ry * scale + sy);
          }
        }
      }
    }
  };

  const lineHeight = glyphH + gap * 2;
  const advance = glyphW + gap;
  for (let oy = margin; oy + glyphH < height - margin; oy += lineHeight) {
    let ox = margin;
    for (const char of SCAN_TEXT) {
      drawGlyph(SCAN_FONT[char] ?? SCAN_FONT[" "]!, ox, oy);
      ox += advance;
      if (ox + glyphW > width - margin) {
        break;
      }
    }
  }

  const compressed = deflateSync(raster);
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  const header = Buffer.from("%PDF-1.7\n%\xff\xff\xff\xff\n", "latin1");
  chunks.push(header);
  let position = header.length;

  const pushObject = (n: number, body: Buffer): void => {
    offsets[n] = position;
    const buf = Buffer.concat([
      Buffer.from(`${n} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1")
    ]);
    chunks.push(buf);
    position += buf.length;
  };

  const contentStream = "q 612 0 0 792 0 0 cm /Im0 Do Q";
  pushObject(1, Buffer.from("<</Type/Catalog/Pages 2 0 R>>", "latin1"));
  pushObject(2, Buffer.from("<</Type/Pages/Kids[3 0 R]/Count 1>>", "latin1"));
  pushObject(
    3,
    Buffer.from(
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
        "/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>",
      "latin1"
    )
  );
  pushObject(
    4,
    Buffer.concat([
      Buffer.from(`<</Length ${contentStream.length}>>\nstream\n`, "latin1"),
      Buffer.from(contentStream, "latin1"),
      Buffer.from("\nendstream", "latin1")
    ])
  );
  pushObject(
    5,
    Buffer.concat([
      Buffer.from(
        `<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
          `/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode/Length ${compressed.length}>>\nstream\n`,
        "latin1"
      ),
      compressed,
      Buffer.from("\nendstream", "latin1")
    ])
  );

  const xrefPosition = position;
  const objectCount = 6;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let n = 1; n < objectCount; n += 1) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<</Size ${objectCount}/Root 1 0 R>>\nstartxref\n${xrefPosition}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

// The full real lane: a supported memory-boundary platform, an importable Docling with the pinned model
// snapshot cached, and OCRmyPDF + Tesseract on PATH. Probed synchronously so `it`/`it.skip` is chosen at
// collection time; any missing piece skips the lane cleanly (CI never provisions the heavy toolchain).
function detectFullRealLane(): { python: string } | null {
  if (!canEnforceStructuredPdfMemoryCeiling(process.platform)) {
    return null;
  }
  try {
    execFileSync("ocrmypdf", ["--version"], { stdio: "ignore" });
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const probe =
    `import docling;from huggingface_hub import snapshot_download;` +
    `snapshot_download('${PINNED_MODEL_REPO}',revision='${PINNED_MODEL_COMMIT}',local_files_only=True)`;
  for (const python of ["python", "python3"]) {
    try {
      execFileSync(python, ["-c", probe], { stdio: "ignore" });
      return { python };
    } catch {
      // interpreter missing, or Docling/models not provisioned — try the next candidate, else skip.
    }
  }
  return null;
}

const fullRealLane = detectFullRealLane();
const workerScriptPath = fileURLToPath(new URL("./pdf_to_docling.py", import.meta.url));

describe("structured PDF conversion — scanned-page timeout (skip-guarded real lane)", () => {
  const realLaneIt = fullRealLane ? it : it.skip;

  realLaneIt(
    "a smallest-scale synthetic scan publishes non-empty content under the production structured timeout (#789)",
    async () => {
      const lane = fullRealLane!;
      const sourceRoot = await makeTempDir("whetstone-789-source-");
      const sourcePath = join(sourceRoot, "scan.pdf");
      await writeFile(sourcePath, generateImageOnlyScanPdf());

      // Real OCR pre-pass over the image-only page (recovers a hidden text layer), as production runs first.
      const ocrRoot = await makeTempDir("whetstone-789-ocr-");
      const ocrPath = join(ocrRoot, "scan-ocr.pdf");
      const ocrPass = createOcrmypdfPass("ocrmypdf");
      const passResult = await ocrPass({
        inputPath: sourcePath,
        outputPath: ocrPath,
        tesseractLanguage: "eng",
        pageNumbersNeedingOcr: [1],
        timeoutMs: 300_000
      });
      expect(passResult.status).toBe("ok");

      // Real structured Docling conversion of the OCR-derived page, bounded by the SAME production owner the
      // live import lane resolves (`resolveStructuredPdfTimeoutMs`). In the field a real scanned page was
      // killed mid-conversion by the pre-fix 180000 ms ceiling (#789); under the fix's resolved 600000 ms
      // bound the OCR-derived page finishes and publishes.
      const adapter = createPdfStructuredAdapter({
        runner: createDoclingRunner({
          pythonBinary: lane.python,
          scriptPath: workerScriptPath,
          perRangeTimeoutMs: resolveStructuredPdfTimeoutMs(undefined),
          memoryMib: defaultStructuredPdfMemoryMib(process.platform)
        }),
        tempDir: await makeTempDir("whetstone-789-convert-")
      });

      const outcome = await adapter.convert(issueStagedFileHandle(ocrRoot, "scan-ocr.pdf"));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      // Observable outcome: a non-empty canonical Work with the recovered scan text on a native-text page —
      // never asserted by an internal class name.
      expect(outcome.document.pages.length).toBeGreaterThan(0);
      expect(outcome.document.pages.some((page) => page.hasNativeText)).toBe(true);
      const recovered = outcome.document.body.map((item) => item.text).join(" ");
      expect(recovered).toContain(SCAN_MARKER);
    },
    660_000
  );
});
