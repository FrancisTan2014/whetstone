import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PAGE_COUNT,
  MAX_STAGED_BYTES,
  RANGE_CONVERSION_SCHEMA_VERSION,
  type ProbePage,
  type RangeConversion
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { pdfImportAttempts } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { createFixturePdfOcrAdapter, type PdfOcrAdapter } from "../../files/pdfOcrAdapter.js";
import { ocrToolMissingFailure } from "../../files/pdfOcrErrors.js";
import {
  createFakeDoclingRunner,
  createUnavailableDoclingRunner,
  type DoclingRunner,
  type ProbeOutcome
} from "../../files/pdfStructuredAdapter.js";
import { malformedFailure } from "../../files/pdfStructuredErrors.js";
import {
  createPdfImportActiveRuns,
  processNextPdfImport,
  type PdfImportRunnerDependencies
} from "./pdfImportRunner.js";
import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";
import {
  PDF_IMPORT_ADAPTER_FINGERPRINT,
  claimNextQueued,
  commitRange,
  getAttempt,
  getCommittedRangeIndices,
  getCommittedRanges,
  insertQueuedAttempt,
  markCancelled,
  recoverInterruptedAttempts,
  retryInterrupted,
  setProbeResult
} from "./pdfImportStore.js";

const doclingSchema = { name: "docling-core", version: "1.10.0" } as const;

function payloadForPages(startPage: number, endPage: number): RangeConversion {
  const pages = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pages.push({ pageNumber: page, hasNativeText: true });
  }
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema,
    pages,
    body: [],
    furniture: []
  };
}

const rawValid = JSON.stringify(payloadForPages(1, 50));
const rawUnsupported = JSON.stringify({
  ...payloadForPages(1, 1),
  doclingSchema: { name: "docling-core", version: "9.9.9" }
});

// A structurally valid PNG (signature + IHDR + short tail) whose dimensions `readPngDimensions` parses.
function pngBytes(width: number, height: number, tail: number): Uint8Array {
  const bytes = new Uint8Array(24 + tail);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 0; index < tail; index += 1) {
    bytes[24 + index] = (index * 5 + 1) & 0xff;
  }
  return bytes;
}

// A runner that writes one rendered-figure PNG into the per-range artifact directory the runner prepared,
// and returns a range payload whose single body picture references it (#807). `sha256` lets a test emit a
// DELIBERATELY wrong digest to exercise the loud integrity-failure path.
function artifactWritingRunner(png: Uint8Array, sha256: string): DoclingRunner {
  return {
    probe: () => Promise.resolve(nativeProbe(1)),
    async convertRange(_pdfPath, startPage, endPage, _signal, artifactDir) {
      await writeFile(join(artifactDir!, "fig-0.png"), png);
      const payload = {
        schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
        doclingSchema,
        pages: [{ pageNumber: startPage, hasNativeText: true }],
        body: [
          {
            label: "picture",
            pageNumber: startPage,
            boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
            charSpan: [0, 0] as const,
            confidence: 0.9,
            text: "",
            children: [],
            imageArtifact: {
              path: "fig-0.png",
              contentType: "image/png" as const,
              sha256,
              byteLength: png.byteLength,
              width: 320,
              height: 200
            }
          }
        ],
        furniture: []
      };
      void endPage;
      return { status: "ok", raw: JSON.stringify(payload) };
    }
  };
}

// Build a probe outcome whose pages are all born-digital (native text), the default a #744 probe reports
// for a text-bearing PDF. Every existing runner test asserts the born-digital path (no OCR), so it routes
// `native` and the OCR phase is skipped — keeping those assertions unchanged while the probe now carries
// the per-page native-text flags the OCR routing reads.
function nativeProbe(pageCount: number): ProbeOutcome {
  const pages: ProbePage[] = [];
  for (let n = 1; n <= pageCount; n += 1) {
    pages.push({ pageNumber: n, width: 612, height: 792, rotation: 0, hasNativeText: true });
  }
  return { status: "ok", pageCount, pages };
}

// Build a probe outcome whose pages are all text-less (scanned), so the runner routes the source through
// the OCR phase. Geometry matches `nativeProbe` so a fixture OCR adapter's before/after geometry checks
// pass; only the native-text flags differ.
function scannedProbe(pageCount: number): ProbeOutcome {
  const pages: ProbePage[] = [];
  for (let n = 1; n <= pageCount; n += 1) {
    pages.push({ pageNumber: n, width: 612, height: 792, rotation: 0, hasNativeText: false });
  }
  return { status: "ok", pageCount, pages };
}

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return createDbClient(pglite);
}

describe("processNextPdfImport", () => {
  let db: DbClient;
  let rootDir: string;
  let stageStore: PdfImportStageStore;

  beforeEach(async () => {
    db = await buildDb();
    rootDir = await mkdtemp(join(tmpdir(), "pdf-import-runner-"));
    stageStore = createPdfImportStageStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  async function seedStaged(id: string, bytes = new Uint8Array([1, 2, 3])): Promise<void> {
    const { stagePath } = await stageStore.createStage(id, bytes);
    await insertQueuedAttempt(db, {
      id,
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath,
      ocrLanguage: "en",
      now: new Date()
    });
  }

  function buildDeps(
    overrides: Partial<PdfImportRunnerDependencies> = {}
  ): PdfImportRunnerDependencies {
    let token = 0;
    return {
      activeRuns: overrides.activeRuns ?? createPdfImportActiveRuns(),
      createRunToken: overrides.createRunToken ?? (() => `rt-${(token += 1)}`),
      db,
      logCleanupFailure: overrides.logCleanupFailure ?? (() => undefined),
      now: overrides.now ?? (() => new Date()),
      pageRangeSize: overrides.pageRangeSize,
      ocrAdapter:
        overrides.ocrAdapter ??
        createFixturePdfOcrAdapter({ outputStageRoot: join(rootDir, "ocr-out") }),
      runner:
        overrides.runner ??
        createFakeDoclingRunner({
          probe: nativeProbe(1),
          rangePayloads: [rawValid]
        }),
      stageStore: overrides.stageStore ?? stageStore
    };
  }

  it("is idle when nothing is queued", async () => {
    expect(await processNextPdfImport(buildDeps())).toEqual({ status: "idle" });
  });

  it("converts a staged attempt range by range and retains its stage for publication", async () => {
    await seedStaged("a1");
    const handlePath = stageStore.openStage("a1").path;
    const deps = buildDeps({
      runner: createFakeDoclingRunner({
        probe: nativeProbe(5),
        rangePayloads: [rawValid]
      }),
      pageRangeSize: 2
    });

    expect(await processNextPdfImport(deps)).toEqual({
      status: "awaiting_review",
      attemptId: "a1"
    });

    const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
    // The stage stays BOUND after conversion — publication persists the original bytes as provenance
    // through the source-file boundary and only then frees the stage.
    expect(attempt).toMatchObject({ state: "awaiting_review", completedPages: 5, stagePath: "a1" });
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([
      0, 1, 2
    ]);
    await expect(stat(handlePath)).resolves.toBeDefined();
  });

  it("adopts a rendered figure artifact and commits its stage-relative path (#807)", async () => {
    await seedStaged("a1");
    const png = pngBytes(320, 200, 16);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const deps = buildDeps({ runner: artifactWritingRunner(png, sha256) });

    expect(await processNextPdfImport(deps)).toEqual({
      status: "awaiting_review",
      attemptId: "a1"
    });

    // The committed range payload carries the adopted picture with its path rewritten to the
    // stage-relative `<rangeIndex>/fig-0.png` form publication reads back.
    const ranges = await getCommittedRanges(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT);
    expect(ranges[0]!.body[0]!.imageArtifact).toMatchObject({
      path: "0/fig-0.png",
      sha256
    });
  });

  it("fails loudly when a rendered figure artifact does not match its manifest (#807)", async () => {
    await seedStaged("a1");
    const png = pngBytes(320, 200, 16);
    // A well-formed but WRONG digest: the file is fine, the manifest lies — loud integrity corruption.
    const deps = buildDeps({ runner: artifactWritingRunner(png, "0".repeat(64)) });

    const result = await processNextPdfImport(deps);
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("artifact_integrity");
  });

  it("resumes after the last committed range without re-probing", async () => {
    await seedStaged("a1");
    const runToken = "prior";
    await claimNextQueued(db, {
      runToken,
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      now: new Date()
    });
    await setProbeResult(db, {
      id: "a1",
      runToken,
      totalPages: 5,
      totalRanges: 3,
      now: new Date()
    });
    await commitRange(db, {
      attemptId: "a1",
      runToken,
      rangeIndex: 0,
      startPage: 1,
      endPage: 2,
      fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
      payload: payloadForPages(1, 2),
      now: new Date()
    });
    await recoverInterruptedAttempts(db, new Date());
    await retryInterrupted(db, DEFAULT_USER_ID, "a1", new Date());

    // A probe that would fail if called proves the resumed run reuses the persisted plan.
    const resumeRunner: DoclingRunner = {
      probe: () => Promise.resolve({ status: "tool_missing" }),
      convertRange: () => Promise.resolve({ status: "ok", raw: rawValid })
    };
    const result = await processNextPdfImport(
      buildDeps({ runner: resumeRunner, pageRangeSize: 2 })
    );
    expect(result.status).toBe("awaiting_review");
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([
      0, 1, 2
    ]);
  });

  describe("probe failures free the stage and fail the attempt", () => {
    const cases: ReadonlyArray<readonly [string, ProbeOutcome, string]> = [
      ["tool missing", { status: "tool_missing" }, "tool_missing"],
      ["password required", { status: "password_required" }, "password_required"],
      ["malformed source", { status: "malformed", detail: "bad header" }, "malformed"],
      ["too many pages", { status: "ok", pageCount: MAX_PAGE_COUNT + 1 }, "too_many_pages"]
    ];

    for (const [name, probe, kind] of cases) {
      it(name, async () => {
        await seedStaged("a1");
        const handlePath = stageStore.openStage("a1").path;
        const result = await processNextPdfImport(
          buildDeps({ runner: createFakeDoclingRunner({ probe }) })
        );
        expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
        const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
        expect(attempt).toMatchObject({ state: "failed", stagePath: null });
        expect(attempt?.failure?.kind).toBe(kind);
        await expect(stat(handlePath)).rejects.toThrow();
      });
    }
  });

  it("fails visibly with no publication when the production runner is unavailable", async () => {
    // The composition root wires this exact runner where the structured PDF toolchain is absent or the
    // platform cannot enforce the memory ceiling. A user upload must fail visibly (tool_missing) and free
    // its stage — never be silently turned into fabricated content.
    await seedStaged("a1");
    const handlePath = stageStore.openStage("a1").path;
    const result = await processNextPdfImport(
      buildDeps({ runner: createUnavailableDoclingRunner() })
    );
    expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
    const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
    expect(attempt).toMatchObject({ state: "failed", stagePath: null });
    expect(attempt?.failure?.kind).toBe("tool_missing");
    await expect(stat(handlePath)).rejects.toThrow();
  });

  describe("durable OCR phase (#745)", () => {
    // A text-less English source (all pages scanned) routes through the OCR pass. The default fixture OCR
    // adapter classifies its own single text-less page, "OCRs" it, and transfers a validated output; the
    // runner adopts that as the derived `ocr.pdf` (recording the fingerprint) and then converts it.
    it("runs the OCR pass for a scanned English source and adopts the derived stage", async () => {
      await seedStaged("a1");
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] })
        })
      );
      expect(result).toEqual({ status: "awaiting_review", attemptId: "a1" });
      const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
      // The adopted fingerprint (non-null) is the recovery boundary; it records the pinned engine/language.
      expect(attempt?.ocrFingerprint).toBe("ocrmypdf@16.10.4/tesseract@5.5.1/eng");
      expect(attempt).toMatchObject({ state: "awaiting_review" });
    });

    // Once an OCR stage is adopted (`ocr_fingerprint` set), a resumed run converts the derived `ocr.pdf`
    // and NEVER re-runs the pass — the adapter would throw if invoked.
    it("resumes from the adopted OCR stage without re-running the pass", async () => {
      await seedStaged("a1");
      await stageStore.writeDerivedStage("a1", new Uint8Array([1, 2, 3]));
      await db
        .update(pdfImportAttempts)
        .set({
          ocrFingerprint: "ocrmypdf@16.10.4/tesseract@5.5.1/eng",
          totalPages: 1,
          totalRanges: 1
        })
        .where(eq(pdfImportAttempts.id, "a1"));
      const throwingOcr: PdfOcrAdapter = {
        execute: () => Promise.reject(new Error("OCR must not run on a resumed adopted attempt"))
      };
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] }),
          ocrAdapter: throwingOcr
        })
      );
      expect(result).toEqual({ status: "awaiting_review", attemptId: "a1" });
    });

    // A cancelled OCR pass is a supersede, not a product failure: the run stops (fenced) without failing
    // the attempt, so the newer run owns its terminal state.
    it("stops (fenced) when the OCR pass reports cancellation", async () => {
      await seedStaged("a1");
      const cancelledOcr: PdfOcrAdapter = {
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: { kind: "cancelled", what: "cancelled", remedy: "retry" }
          })
      };
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] }),
          ocrAdapter: cancelledOcr
        })
      );
      expect(result).toEqual({ status: "fenced", attemptId: "a1" });
      // The attempt is NOT failed — it stays claimable for the superseding run.
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.state).not.toBe("failed");
    });

    // A non-cancelled OCR failure fails the attempt visibly and frees its stage — never a silent publish.
    it("fails the attempt and frees the stage when the OCR pass fails", async () => {
      await seedStaged("a1");
      const handlePath = stageStore.openStage("a1").path;
      const failingOcr: PdfOcrAdapter = {
        execute: () => Promise.resolve({ ok: false, failure: ocrToolMissingFailure() })
      };
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] }),
          ocrAdapter: failingOcr
        })
      );
      expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
      const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(attempt).toMatchObject({ state: "failed", stagePath: null });
      expect(attempt?.failure?.kind).toBe("tool_missing");
      await expect(stat(handlePath)).rejects.toThrow();
    });

    // A born-digital source never touches the OCR adapter: routing is `native`, so the original converts
    // untouched and no fingerprint is recorded.
    it("skips the OCR pass for a born-digital source", async () => {
      await seedStaged("a1");
      const throwingOcr: PdfOcrAdapter = {
        execute: () => Promise.reject(new Error("OCR must not run for a born-digital source"))
      };
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: nativeProbe(2), rangePayloads: [rawValid] }),
          ocrAdapter: throwingOcr,
          pageRangeSize: 2
        })
      );
      expect(result).toEqual({ status: "awaiting_review", attemptId: "a1" });
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.ocrFingerprint).toBeNull();
    });

    // Seed a resumed pre-adoption attempt: probe totals are persisted (so the resumed run skips the
    // once-per-attempt probe), but no OCR stage is adopted (`ocr_fingerprint` null) and no range is
    // committed (`completedPages` 0). The OCR phase therefore has no probe pages in hand and must
    // RE-probe the original to classify routing.
    async function seedResumedPreAdoption(id: string): Promise<void> {
      await seedStaged(id);
      await claimNextQueued(db, {
        runToken: "prior",
        fingerprint: PDF_IMPORT_ADAPTER_FINGERPRINT,
        now: new Date()
      });
      await setProbeResult(db, {
        id,
        runToken: "prior",
        totalPages: 1,
        totalRanges: 1,
        now: new Date()
      });
      await recoverInterruptedAttempts(db, new Date());
      await retryInterrupted(db, DEFAULT_USER_ID, id, new Date());
    }

    // A resumed run that adopted nothing and committed nothing re-probes the ORIGINAL for routing —
    // safe because no OCR stage is adopted yet, so re-probing (and re-OCRing) loses nothing. A scanned
    // re-probe routes the pass, adopts the derived stage, and converts.
    it("re-probes a resumed pre-adoption run to route OCR, then adopts and converts", async () => {
      await seedResumedPreAdoption("a1");
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] })
        })
      );
      expect(result).toEqual({ status: "awaiting_review", attemptId: "a1" });
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.ocrFingerprint).toBe(
        "ocrmypdf@16.10.4/tesseract@5.5.1/eng"
      );
    });

    // The resumed pre-adoption re-probe reads the original through the same probe path; a probe failure
    // (here the toolchain went missing) fails the attempt visibly and frees its stage — never a silent
    // publish from a source it could not classify.
    it("fails a resumed pre-adoption run when the OCR routing re-probe fails", async () => {
      await seedResumedPreAdoption("a1");
      const handlePath = stageStore.openStage("a1").path;
      const failingProbe: DoclingRunner = {
        probe: () => Promise.resolve({ status: "tool_missing" }),
        convertRange: () => Promise.resolve({ status: "ok", raw: rawValid })
      };
      const result = await processNextPdfImport(buildDeps({ runner: failingProbe }));
      expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
      const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
      expect(attempt).toMatchObject({ state: "failed", stagePath: null });
      expect(attempt?.failure?.kind).toBe("tool_missing");
      await expect(stat(handlePath)).rejects.toThrow();
    });

    // A cancel that lands DURING the routing re-probe (after the probe totals were persisted, before the
    // phase advances to `ocr`) fences the `setPhase("ocr")` write: the run stops (fenced) without failing
    // the attempt, leaving its terminal state to the superseding run.
    it("stops (fenced) when a cancel lands before the OCR phase is set on a resumed run", async () => {
      await seedResumedPreAdoption("a1");
      const cancellingProbe: DoclingRunner = {
        probe: async () => {
          await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
          return scannedProbe(1);
        },
        convertRange: () => Promise.resolve({ status: "ok", raw: rawValid })
      };
      const result = await processNextPdfImport(buildDeps({ runner: cancellingProbe }));
      expect(result).toEqual({ status: "fenced", attemptId: "a1" });
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.state).not.toBe("failed");
    });

    // A cancel that lands DURING the OCR pass itself (after the phase is `ocr`, before adoption) fences
    // the atomic `adoptOcrStage` write: the derived bytes were produced but the fingerprint is never
    // recorded, so the run stops (fenced) and no OCR stage is adopted (`ocr_fingerprint` stays null).
    it("stops (fenced) when a cancel lands during the OCR pass before adoption", async () => {
      await seedStaged("a1");
      const fixtureOcr = createFixturePdfOcrAdapter({ outputStageRoot: join(rootDir, "ocr-out") });
      const cancelDuringOcr: PdfOcrAdapter = {
        execute: async (request) => {
          const outcome = await fixtureOcr.execute(request);
          await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
          return outcome;
        }
      };
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] }),
          ocrAdapter: cancelDuringOcr
        })
      );
      expect(result).toEqual({ status: "fenced", attemptId: "a1" });
      expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.ocrFingerprint).toBeNull();
    });

    // The OCR pass validated its output, but the runner could not copy it into the attempt-owned derived
    // stage: the transient output was unreadable, or the derived `ocr.pdf` write failed (disk, permission,
    // or a missing stage directory). This must fail the attempt VISIBLY (typed `stage_write`) and free its
    // stage — never reject out of `processNextPdfImport`. A rejection here would leave the attempt `running`
    // with its run token held, so no later drain tick could claim any PDF import until a restart ran
    // interruption recovery.
    it("fails the attempt (never rejects) when the derived OCR stage copy/write fails", async () => {
      await seedStaged("a1");
      const handlePath = stageStore.openStage("a1").path;
      const failingDerivedWrite: PdfImportStageStore = {
        ...stageStore,
        writeDerivedStage: () => Promise.reject(new Error("stage directory vanished"))
      };
      const result = await processNextPdfImport(
        buildDeps({
          runner: createFakeDoclingRunner({ probe: scannedProbe(1), rangePayloads: [rawValid] }),
          stageStore: failingDerivedWrite
        })
      );
      expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
      const attempt = await getAttempt(db, DEFAULT_USER_ID, "a1");
      // A typed failed attempt — never stuck `running`: the run token is released and the stage freed, so
      // the next drain tick can claim work. The fingerprint was never adopted (the write never landed).
      expect(attempt).toMatchObject({ state: "failed", stagePath: null });
      expect(attempt?.ocrFingerprint).toBeNull();
      expect(attempt?.failure?.kind).toBe("stage_write");
      await expect(stat(handlePath)).rejects.toThrow();
    });
  });

  it("fails on a malformed range payload", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: nativeProbe(1),
          rangePayloads: ["{not json"]
        })
      })
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails on an unsupported converter schema", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: nativeProbe(1),
          rangePayloads: [rawUnsupported]
        })
      })
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("unsupported_schema");
  });

  it("fails on a non-cancelled range run failure", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: nativeProbe(1),
          failRangeWith: malformedFailure("boom")
        })
      })
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("stops (fenced) when a range run reports cancellation", async () => {
    await seedStaged("a1");
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({
          probe: nativeProbe(1),
          failRangeWith: { kind: "cancelled", what: "cancelled", remedy: "retry" }
        })
      })
    );
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
  });

  it("stops (fenced) when the signal is aborted between ranges", async () => {
    await seedStaged("a1");
    const activeRuns = createPdfImportActiveRuns();
    let captured: AbortController | undefined;
    const wrapped = {
      register: (id: string, tok: string, controller: AbortController) => {
        captured = controller;
        activeRuns.register(id, tok, controller);
      },
      abort: activeRuns.abort,
      clear: activeRuns.clear
    };
    let calls = 0;
    const abortingRunner: DoclingRunner = {
      probe: () => Promise.resolve(nativeProbe(2)),
      convertRange: () => {
        calls += 1;
        if (calls === 1) {
          captured?.abort();
        }
        return Promise.resolve({ status: "ok", raw: rawValid });
      }
    };
    const result = await processNextPdfImport(
      buildDeps({ runner: abortingRunner, activeRuns: wrapped, pageRangeSize: 1 })
    );
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
    // The first range committed before the abort; the run stopped without failing the attempt.
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([0]);
  });

  it("fences the probe write when a cancel lands mid-probe", async () => {
    await seedStaged("a1");
    const cancellingRunner: DoclingRunner = {
      probe: async () => {
        await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
        return nativeProbe(1);
      },
      convertRange: () => Promise.resolve({ status: "ok", raw: rawValid })
    };
    const result = await processNextPdfImport(buildDeps({ runner: cancellingRunner }));
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
  });

  it("fences a range commit when a cancel lands mid-range", async () => {
    await seedStaged("a1");
    const cancellingRunner: DoclingRunner = {
      probe: () => Promise.resolve(nativeProbe(1)),
      convertRange: async () => {
        await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
        return { status: "ok", raw: rawValid };
      }
    };
    const result = await processNextPdfImport(buildDeps({ runner: cancellingRunner }));
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
    expect(await getCommittedRangeIndices(db, "a1", PDF_IMPORT_ADAPTER_FINGERPRINT)).toEqual([]);
  });

  it("fences the failure write when a cancel lands with a range failure", async () => {
    await seedStaged("a1");
    const cancellingRunner: DoclingRunner = {
      probe: () => Promise.resolve(nativeProbe(1)),
      convertRange: async () => {
        await markCancelled(db, DEFAULT_USER_ID, "a1", new Date());
        return { status: "failure", failure: malformedFailure("boom") };
      }
    };
    const result = await processNextPdfImport(buildDeps({ runner: cancellingRunner }));
    expect(result).toEqual({ status: "fenced", attemptId: "a1" });
  });

  it("fails a claim with no bound stage", async () => {
    await seedStaged("a1");
    await db
      .update(pdfImportAttempts)
      .set({ stagePath: null })
      .where(eq(pdfImportAttempts.id, "a1"));
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails when the stage handle cannot be opened", async () => {
    // A stage path that is not a safe server-issued id makes openStage throw.
    await insertQueuedAttempt(db, {
      id: "a1",
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath: "bad/id",
      ocrLanguage: "en",
      now: new Date()
    });
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails when the staged bytes cannot be read", async () => {
    // A valid stage id whose file was never written: openStage succeeds, stat fails.
    await insertQueuedAttempt(db, {
      id: "a1",
      userId: DEFAULT_USER_ID,
      sourceHash: "a".repeat(64),
      stagePath: "a1",
      ocrLanguage: "en",
      now: new Date()
    });
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("malformed");
  });

  it("fails an oversized staged file before spawning a child", async () => {
    await seedStaged("a1");
    await truncate(stageStore.openStage("a1").path, MAX_STAGED_BYTES + 1);
    const result = await processNextPdfImport(buildDeps());
    expect(result).toMatchObject({ status: "failed" });
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.failure?.kind).toBe("too_large");
  });

  it("retains the stage (bound, retryable) when cleanup fails after a failed conversion", async () => {
    // A failed attempt frees its stage (it never publishes). If that removal fails, the binding must be
    // retained and the bytes kept, so the terminal attempt stays bound and its cleanup can be retried.
    await seedStaged("a1");
    const handlePath = stageStore.openStage("a1").path;
    const logCleanupFailure = vi.fn();
    const failingStore: PdfImportStageStore = {
      createStage: stageStore.createStage,
      createStageFromStream: stageStore.createStageFromStream,
      openStage: stageStore.openStage,
      readStage: stageStore.readStage,
      // A non-Error rejection also exercises the String(cause) fallback in the cleanup log.
      removeStage: () => Promise.reject("stage locked")
    };
    const result = await processNextPdfImport(
      buildDeps({
        runner: createFakeDoclingRunner({ probe: { status: "tool_missing" } }),
        stageStore: failingStore,
        logCleanupFailure
      })
    );
    expect(result).toMatchObject({ status: "failed", attemptId: "a1" });
    expect(logCleanupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "a1", reason: "stage locked" })
    );
    // A failed removal must not forget the stage: the binding is retained and the bytes still exist.
    expect((await getAttempt(db, DEFAULT_USER_ID, "a1"))?.stagePath).toBe("a1");
    await expect(stat(handlePath)).resolves.toBeDefined();
  });
});

describe("createPdfImportActiveRuns", () => {
  it("aborts the registered controller and ignores an unknown id", () => {
    const runs = createPdfImportActiveRuns();
    const controller = new AbortController();
    runs.register("a1", "t1", controller);
    runs.abort("missing");
    expect(controller.signal.aborted).toBe(false);
    runs.abort("a1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("clears only when the run token matches", () => {
    const runs = createPdfImportActiveRuns();
    const first = new AbortController();
    runs.register("a1", "t1", first);
    // A stale clear (wrong token) must not drop the live controller.
    runs.clear("a1", "other");
    runs.abort("a1");
    expect(first.signal.aborted).toBe(true);
    // The matching clear removes it, so a later abort is a no-op.
    runs.clear("a1", "t1");
    expect(() => runs.abort("a1")).not.toThrow();
  });
});
