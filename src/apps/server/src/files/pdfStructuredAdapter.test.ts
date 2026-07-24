import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseRangeConversion,
  PINNED_MODEL_COMMIT,
  PINNED_MODEL_REPO,
  RANGE_CONVERSION_SCHEMA_VERSION,
  STRUCTURED_DOCUMENT_SCHEMA_VERSION,
  SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS,
  validateStructuredDocument
} from "@whetstone/contracts";

import {
  canEnforceStructuredPdfMemoryCeiling,
  createDoclingRunner,
  createFakePdfStructuredAdapter,
  createPdfStructuredAdapter,
  createStagedFixtureDoclingRunner,
  createUnavailableDoclingRunner,
  defaultRangePayload,
  issueStagedFileHandle,
  pageRangesFor,
  STRUCTURED_PDF_FIXTURE_MARKER,
  type DoclingRunner,
  type ProbeOutcome,
  type RangeRunOutcome,
  type StagedFileHandle,
  type StructuredConversionOutcome
} from "./pdfStructuredAdapter.js";
import { timeoutFailure } from "./pdfStructuredErrors.js";

const supportedVersion = SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS[0]!;
const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function stageFile(bytes: Uint8Array): Promise<StagedFileHandle> {
  const stageRoot = await makeTempDir("whetstone-stage-");
  await writeFile(join(stageRoot, "staged.pdf"), bytes);
  return issueStagedFileHandle(stageRoot, "staged.pdf");
}

function rangePayload(pageNumber: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema: { name: "DoclingDocument", version: supportedVersion },
    pages: [{ pageNumber, hasNativeText: true }],
    body: [
      {
        label: "text",
        pageNumber,
        boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
        charSpan: [0, 4],
        confidence: 1,
        text: `page ${pageNumber}`,
        children: []
      }
    ],
    furniture: [],
    ...overrides
  });
}

function expectFailure(outcome: StructuredConversionOutcome, kind: string): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a failure outcome");
  expect(outcome.failure.kind).toBe(kind);
}

// Build an `ok` probe outcome with default per-page geometry, so a test that only cares about the page
// count need not restate width/height/rotation for every page.
function okProbe(pageCount: number): ProbeOutcome {
  return {
    status: "ok",
    pageCount,
    pages: Array.from({ length: pageCount }, (_unused, index) => ({
      pageNumber: index + 1,
      width: 612,
      height: 792,
      rotation: 0,
      hasNativeText: true
    }))
  };
}

describe("issueStagedFileHandle", () => {
  it("resolves a simple server-issued name within the stage root", () => {
    const handle = issueStagedFileHandle("Q:/stage", "abc123.pdf");
    expect(handle.path.endsWith("abc123.pdf")).toBe(true);
    expect(handle.stageRoot.length).toBeGreaterThan(0);
  });

  it("rejects `.`, `..`, and names containing path separators (traversal resistance)", () => {
    expect(() => issueStagedFileHandle("Q:/stage", ".")).toThrow();
    expect(() => issueStagedFileHandle("Q:/stage", "..")).toThrow();
    expect(() => issueStagedFileHandle("Q:/stage", "a/b")).toThrow();
    expect(() => issueStagedFileHandle("Q:/stage", "a\\b")).toThrow();
    expect(() => issueStagedFileHandle("Q:/stage", "../escape")).toThrow();
  });
});

describe("createPdfStructuredAdapter — forged handle", () => {
  it("refuses a fabricated/out-of-root handle before any filesystem read", async () => {
    // A handle NOT produced by issueStagedFileHandle carries no server witness, so even one pointing
    // at an arbitrary absolute path outside any stage root must be refused before stat/readFile runs.
    const forged = {
      path: "/etc/passwd",
      stageRoot: "/etc"
    } as unknown as StagedFileHandle;

    const probe = vi.fn(() => Promise.resolve<ProbeOutcome>(okProbe(1)));
    const adapter = createPdfStructuredAdapter({
      runner: {
        probe,
        convertRange: () => Promise.resolve({ status: "ok", raw: rangePayload(1) })
      },
      tempDir: await makeTempDir("whetstone-temp-")
    });

    const outcome = await adapter.convert(forged);
    expectFailure(outcome, "forbidden_handle");
    // The read never started: the runner was never consulted for a forged handle.
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("pageRangesFor", () => {
  it("splits into contiguous source-ordered ranges of at most `size` pages", () => {
    expect(pageRangesFor(5, 2)).toEqual([
      { startPage: 1, endPage: 2 },
      { startPage: 3, endPage: 4 },
      { startPage: 5, endPage: 5 }
    ]);
    expect(pageRangesFor(0, 2)).toEqual([]);
  });
});

describe("defaultRangePayload", () => {
  it("is a valid range preserving a low-confidence, unknown-label item (nothing dropped)", () => {
    const result = parseRangeConversion(defaultRangePayload());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    const labels = result.value.body.map((entry) => entry.label);
    expect(labels).toContain("some_unknown_label");
    expect(result.value.body.some((entry) => entry.confidence < 0.5)).toBe(true);
  });
});

describe("createPdfStructuredAdapter — success", () => {
  it("converts a staged PDF into a validated structured document with source provenance", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    const handle = await stageFile(bytes);
    const adapter = createFakePdfStructuredAdapter();

    const outcome = await adapter.convert(handle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    expect(validateStructuredDocument(outcome.document).ok).toBe(true);
    expect(outcome.document.source.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(outcome.document.source.byteLength).toBe(bytes.byteLength);
    expect(outcome.document.pages[0]).toEqual({ pageNumber: 1, hasNativeText: true });
    // The default payload's low-confidence unknown item survives to the assembled document.
    expect(outcome.document.body.some((entry) => entry.label === "some_unknown_label")).toBe(true);
  });

  it("concatenates multiple ranges in source order and sorts pages", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const tempDir = await makeTempDir("whetstone-temp-");
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({
        probe: okProbe(3),
        rangePayloads: [rangePayload(2), rangePayload(1), rangePayload(3)]
      }),
      limits: { pageRangeSize: 1 },
      tempDir
    });

    const outcome = await adapter.convert(handle);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.document.body.map((entry) => entry.text)).toEqual([
      "page 2",
      "page 1",
      "page 3"
    ]);
    expect(outcome.document.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(outcome.document.source.pageCount).toBe(3);
  });
});

// A configurable in-memory runner for the failure/boundary cases the convenience fake does not cover.
function fakeRunner(config: {
  probe?: ProbeOutcome;
  rangePayloads?: string[];
  failRange?: RangeRunOutcome;
  onRange?: () => void;
}): DoclingRunner {
  let index = 0;
  return {
    probe: () => Promise.resolve(config.probe ?? okProbe(1)),
    convertRange: () => {
      config.onRange?.();
      if (config.failRange) return Promise.resolve(config.failRange);
      const payloads = config.rangePayloads ?? [rangePayload(1)];
      const raw = payloads[Math.min(index, payloads.length - 1)]!;
      index += 1;
      return Promise.resolve({ status: "ok", raw });
    }
  };
}

describe("createPdfStructuredAdapter — bounds and failures", () => {
  it("rejects a staged file above the byte ceiling from its stat, as too_large", async () => {
    const handle = await stageFile(new Uint8Array(32));
    const adapter = createFakePdfStructuredAdapter(undefined, { maxStagedBytes: 8 });
    expectFailure(await adapter.convert(handle), "too_large");
  });

  it("rejects a document above the page ceiling as too_many_pages", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ probe: okProbe(10) }),
      limits: { maxPageCount: 5 },
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "too_many_pages");
  });

  it("maps a password-required probe to password_required", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ probe: { status: "password_required" } }),
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "password_required");
  });

  it("maps a tool-missing probe to tool_missing", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ probe: { status: "tool_missing" } }),
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "tool_missing");
  });

  it("maps a malformed probe to malformed", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ probe: { status: "malformed", detail: "no page tree" } }),
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "malformed");
  });

  it("passes a range-run failure through unchanged", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ failRange: { status: "failure", failure: timeoutFailure(500) } }),
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "timeout");
  });

  it("maps a malformed range payload to malformed", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ rangePayloads: ["{not json"] }),
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "malformed");
  });

  it("maps an unsupported docling schema in a range payload to unsupported_schema", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({
        rangePayloads: [
          rangePayload(1, { doclingSchema: { name: "DoclingDocument", version: "0.0.9" } })
        ]
      }),
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle), "unsupported_schema");
  });

  it("surfaces a configured range failure from the convenience fake runner", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createFakePdfStructuredAdapter({ failRangeWith: timeoutFailure(500) });
    expectFailure(await adapter.convert(handle), "timeout");
  });
});

describe("createPdfStructuredAdapter — cancellation", () => {
  it("returns cancelled without touching the file when the signal is already aborted", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const probe = vi.fn(() => Promise.resolve<ProbeOutcome>(okProbe(1)));
    const adapter = createPdfStructuredAdapter({
      runner: {
        probe,
        convertRange: () => Promise.resolve({ status: "ok", raw: rangePayload(1) })
      },
      tempDir: await makeTempDir("whetstone-temp-")
    });
    expectFailure(await adapter.convert(handle, { signal: AbortSignal.abort() }), "cancelled");
    expect(probe).not.toHaveBeenCalled();
  });

  it("stops before the next range when cancelled mid-conversion", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const controller = new AbortController();
    const convertRange = vi.fn(() => {
      controller.abort();
      return Promise.resolve<RangeRunOutcome>({ status: "ok", raw: rangePayload(1) });
    });
    const adapter = createPdfStructuredAdapter({
      runner: { probe: () => Promise.resolve(okProbe(2)), convertRange },
      limits: { pageRangeSize: 1 },
      tempDir: await makeTempDir("whetstone-temp-")
    });

    expectFailure(await adapter.convert(handle, { signal: controller.signal }), "cancelled");
    expect(convertRange).toHaveBeenCalledTimes(1);
  });
});

describe("createPdfStructuredAdapter — I/O and cleanup", () => {
  it("reports a missing stage as malformed (stat failure)", async () => {
    const stageRoot = await makeTempDir("whetstone-stage-");
    const handle = issueStagedFileHandle(stageRoot, "absent.pdf");
    expectFailure(await createFakePdfStructuredAdapter().convert(handle), "malformed");
  });

  it("reports an unreadable stage (a directory) as malformed (read failure)", async () => {
    const stageRoot = await makeTempDir("whetstone-stage-");
    await mkdir(join(stageRoot, "adir.pdf"));
    const handle = issueStagedFileHandle(stageRoot, "adir.pdf");
    expectFailure(await createFakePdfStructuredAdapter().convert(handle), "malformed");
  });

  it("reports a working-directory creation failure as malformed", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createFakePdfStructuredAdapter(undefined);
    const adapterWithBadTemp = createPdfStructuredAdapter({
      runner: fakeRunner({}),
      tempDir: join(tmpdir(), "whetstone-does-not-exist-xyz", "deeper")
    });
    void adapter;
    expectFailure(await adapterWithBadTemp.convert(handle), "malformed");
  });

  it("reports an unexpected runner error as malformed, still cleaning up", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const removeWorkingDir = vi.fn(() => Promise.resolve());
    const adapter = createPdfStructuredAdapter({
      runner: {
        probe: () => Promise.reject(new Error("boom")),
        convertRange: () => Promise.reject(new Error("no"))
      },
      tempDir: await makeTempDir("whetstone-temp-"),
      removeWorkingDir
    });
    expectFailure(await adapter.convert(handle), "malformed");
    expect(removeWorkingDir).toHaveBeenCalledOnce();
  });

  it("describes a non-Error runner rejection as malformed (String cause arm)", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: {
        probe: () => Promise.reject("boom-string"),
        convertRange: () => Promise.reject("no")
      },
      tempDir: await makeTempDir("whetstone-temp-")
    });
    const outcome = await adapter.convert(handle);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("malformed");
    expect(outcome.failure.what).toContain("boom-string");
  });

  it("surfaces a cleanup failure after an otherwise successful conversion", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({}),
      tempDir: await makeTempDir("whetstone-temp-"),
      removeWorkingDir: () => Promise.reject(new Error("EACCES"))
    });
    expectFailure(await adapter.convert(handle), "cleanup");
  });

  it("keeps a real failure's priority when cleanup also fails", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    const adapter = createPdfStructuredAdapter({
      runner: fakeRunner({ probe: { status: "tool_missing" } }),
      tempDir: await makeTempDir("whetstone-temp-"),
      removeWorkingDir: () => Promise.reject(new Error("EACCES"))
    });
    expectFailure(await adapter.convert(handle), "tool_missing");
  });
});

describe("createPdfStructuredAdapter — single-flight", () => {
  it("runs one conversion at a time even under concurrent callers", async () => {
    const handle = await stageFile(new Uint8Array([1]));
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;

    const runner: DoclingRunner = {
      probe: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (first) {
          first = false;
          await gate;
        }
        active -= 1;
        return okProbe(1);
      },
      convertRange: () => Promise.resolve({ status: "ok", raw: rangePayload(1) })
    };

    const adapter = createPdfStructuredAdapter({
      runner,
      tempDir: await makeTempDir("whetstone-temp-")
    });

    const firstConvert = adapter.convert(handle);
    const secondConvert = adapter.convert(handle);
    // The second conversion cannot enter the runner until the first releases the gate.
    await Promise.resolve();
    release?.();

    const [a, b] = await Promise.all([firstConvert, secondConvert]);
    expect(a.ok && b.ok).toBe(true);
    expect(maxActive).toBe(1);
  });
});

// The one validated-JSON contract both the deterministic fake and the real Docling-backed adapter must
// satisfy. Asserted structurally (schema, provenance, page invariants) so it holds regardless of a
// specific PDF's content — this is the SAME oracle for both lanes (#701 review, item 2).
function assertStructuredDocumentContract(
  outcome: StructuredConversionOutcome,
  bytes: Uint8Array
): void {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("expected a successful conversion");
  const { document } = outcome;
  expect(validateStructuredDocument(document).ok).toBe(true);
  expect(document.schemaVersion).toBe(STRUCTURED_DOCUMENT_SCHEMA_VERSION);
  expect(document.doclingSchema.name).toBe("DoclingDocument");
  expect(SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS).toContain(document.doclingSchema.version);
  expect(document.source.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(document.source.byteLength).toBe(bytes.byteLength);
  expect(document.source.pageCount).toBe(document.pages.length);
  expect(document.pages.length).toBeGreaterThan(0);
  const pageNumbers = document.pages.map((page) => page.pageNumber);
  expect([...pageNumbers].sort((a, b) => a - b)).toEqual(pageNumbers);
  for (const page of document.pages) {
    expect(page.pageNumber).toBeGreaterThanOrEqual(1);
    expect(typeof page.hasNativeText).toBe("boolean");
  }
}

// The real lane runs the actual spawn/worker wiring, so it needs a POSIX platform (the memory-ceiling
// fence), a Python with Docling importable, and the pinned model snapshot cached locally. When any is
// missing it skips cleanly — CI does not provision the heavy toolchain. Probed synchronously so
// `it`/`it.skip` is chosen at collection time.
function detectRealLane(): { python: string } | null {
  if (!canEnforceStructuredPdfMemoryCeiling(process.platform)) {
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

const realLane = detectRealLane();
const workerScriptPath = fileURLToPath(new URL("./pdf_to_docling.py", import.meta.url));
const samplePdfPath = fileURLToPath(
  new URL("./tests/fixtures/structured/sample.pdf", import.meta.url)
);

describe("structured PDF adapter — shared validated-JSON contract", () => {
  it("the deterministic fake adapter satisfies the contract", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    const handle = await stageFile(bytes);
    assertStructuredDocumentContract(await createFakePdfStructuredAdapter().convert(handle), bytes);
  });

  const realLaneIt = realLane ? it : it.skip;
  realLaneIt(
    "the real Docling-backed adapter satisfies the same contract (skip-guarded)",
    async () => {
      const bytes = new Uint8Array(readFileSync(samplePdfPath));
      const stageRoot = await makeTempDir("whetstone-real-stage-");
      await writeFile(join(stageRoot, "sample.pdf"), bytes);
      const handle = issueStagedFileHandle(stageRoot, "sample.pdf");
      const adapter = createPdfStructuredAdapter({
        runner: createDoclingRunner({
          pythonBinary: realLane!.python,
          scriptPath: workerScriptPath,
          perRangeTimeoutMs: 120_000,
          memoryMib: 2048
        }),
        tempDir: await makeTempDir("whetstone-real-temp-")
      });
      assertStructuredDocumentContract(await adapter.convert(handle), bytes);
    },
    130_000
  );
});

describe("createDoclingRunner", () => {
  it("exposes the runner contract on a platform that can enforce the memory ceiling", () => {
    const runner = createDoclingRunner({
      pythonBinary: "python",
      scriptPath: "pdf_to_docling.py",
      perRangeTimeoutMs: 1000,
      memoryMib: 512,
      platform: "linux"
    });
    expect(typeof runner.probe).toBe("function");
    expect(typeof runner.convertRange).toBe("function");
  });

  it("refuses to construct where a per-child memory ceiling cannot be enforced (win32)", () => {
    expect(() =>
      createDoclingRunner({
        pythonBinary: "python",
        scriptPath: "pdf_to_docling.py",
        perRangeTimeoutMs: 1000,
        memoryMib: 512,
        platform: "win32"
      })
    ).toThrow(/memory ceiling/i);
  });

  it("exposes the platform fence as a pure predicate", () => {
    expect(canEnforceStructuredPdfMemoryCeiling("linux")).toBe(true);
    expect(canEnforceStructuredPdfMemoryCeiling("darwin")).toBe(true);
    expect(canEnforceStructuredPdfMemoryCeiling("win32")).toBe(false);
  });

  it("defaults to the host platform when none is injected", () => {
    // Exercises the `?? process.platform` fallback: construct on a POSIX host, refuse on Windows.
    const make = (): DoclingRunner =>
      createDoclingRunner({
        pythonBinary: "python",
        scriptPath: "pdf_to_docling.py",
        perRangeTimeoutMs: 1000,
        memoryMib: 512
      });
    if (canEnforceStructuredPdfMemoryCeiling(process.platform)) {
      expect(typeof make().probe).toBe("function");
    } else {
      expect(make).toThrow(/memory ceiling/i);
    }
  });
});

function fixtureConversionJson(
  pages: readonly Readonly<{ pageNumber: number; hasNativeText: boolean }>[]
): string {
  return JSON.stringify({
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema: { name: "DoclingDocument", version: supportedVersion },
    pages,
    body: pages.map((page) => ({
      label: "text",
      pageNumber: page.pageNumber,
      boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
      charSpan: [0, 4],
      confidence: 1,
      text: `page ${page.pageNumber}`,
      children: []
    })),
    furniture: []
  });
}

function fixtureBytes(conversionJson: string, header = "%PDF-1.7\n"): Uint8Array {
  return new TextEncoder().encode(`${header}${STRUCTURED_PDF_FIXTURE_MARKER}\n${conversionJson}`);
}

describe("createUnavailableDoclingRunner", () => {
  it("probes as tool_missing so no upload is ever silently converted", async () => {
    const runner = createUnavailableDoclingRunner();
    expect(await runner.probe("Q:/stage/anything.pdf", undefined)).toEqual({
      status: "tool_missing"
    });
  });

  it("fails every range with a tool_missing failure", async () => {
    const runner = createUnavailableDoclingRunner();
    const outcome = await runner.convertRange("Q:/stage/anything.pdf", 1, 3, undefined);
    expect(outcome.status).toBe("failure");
    if (outcome.status !== "failure") throw new Error("expected a failure outcome");
    expect(outcome.failure.kind).toBe("tool_missing");
  });
});

describe("createStagedFixtureDoclingRunner", () => {
  it("probes the actual staged bytes, reporting the embedded page count", async () => {
    const runner = createStagedFixtureDoclingRunner();
    const handle = await stageFile(
      fixtureBytes(
        fixtureConversionJson([
          { pageNumber: 1, hasNativeText: true },
          { pageNumber: 2, hasNativeText: true }
        ])
      )
    );
    expect(await runner.probe(handle.path, undefined)).toEqual({
      status: "ok",
      pageCount: 2,
      pages: [
        { pageNumber: 1, width: 612, height: 792, rotation: 0, hasNativeText: true },
        { pageNumber: 2, width: 612, height: 792, rotation: 0, hasNativeText: true }
      ]
    });
  });

  it("converts only the requested page window from the staged bytes", async () => {
    const runner = createStagedFixtureDoclingRunner();
    const handle = await stageFile(
      fixtureBytes(
        fixtureConversionJson([
          { pageNumber: 1, hasNativeText: true },
          { pageNumber: 2, hasNativeText: true },
          { pageNumber: 3, hasNativeText: true }
        ])
      )
    );
    const outcome = await runner.convertRange(handle.path, 2, 3, undefined);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected an ok outcome");
    const parsed = parseRangeConversion(outcome.raw);
    if (parsed.status !== "ok") throw new Error(`fixture output invalid: ${parsed.status}`);
    expect(parsed.value.pages.map((page) => page.pageNumber)).toEqual([2, 3]);
    expect(parsed.value.body.map((docItem) => docItem.pageNumber)).toEqual([2, 3]);
  });

  it("carries a scanned page through so the OCR-required outcome can surface", async () => {
    const runner = createStagedFixtureDoclingRunner();
    const handle = await stageFile(
      fixtureBytes(fixtureConversionJson([{ pageNumber: 1, hasNativeText: false }]))
    );
    const outcome = await runner.convertRange(handle.path, 1, 1, undefined);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected an ok outcome");
    const parsed = parseRangeConversion(outcome.raw);
    if (parsed.status !== "ok") throw new Error(`fixture output invalid: ${parsed.status}`);
    expect(parsed.value.pages[0]?.hasNativeText).toBe(false);
  });

  it("reports tool_missing when the staged bytes carry no embedded fixture", async () => {
    const runner = createStagedFixtureDoclingRunner();
    const handle = await stageFile(
      new TextEncoder().encode("%PDF-1.7\nreal pdf, no fixture marker")
    );
    expect(await runner.probe(handle.path, undefined)).toEqual({ status: "tool_missing" });
    const outcome = await runner.convertRange(handle.path, 1, 1, undefined);
    expect(outcome.status).toBe("failure");
    if (outcome.status !== "failure") throw new Error("expected a failure outcome");
    expect(outcome.failure.kind).toBe("tool_missing");
  });

  it("reports tool_missing when the staged file cannot be read", async () => {
    const runner = createStagedFixtureDoclingRunner();
    expect(await runner.probe("Q:/stage/does-not-exist.pdf", undefined)).toEqual({
      status: "tool_missing"
    });
  });

  it("reports tool_missing when the embedded fixture is malformed", async () => {
    const runner = createStagedFixtureDoclingRunner();
    const handle = await stageFile(fixtureBytes("{ not a valid conversion }"));
    expect(await runner.probe(handle.path, undefined)).toEqual({ status: "tool_missing" });
  });
});
