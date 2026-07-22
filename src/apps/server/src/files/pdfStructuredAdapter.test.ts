import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseRangeConversion,
  RANGE_CONVERSION_SCHEMA_VERSION,
  SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS,
  validateStructuredDocument
} from "@whetstone/contracts";

import {
  createDoclingRunner,
  createFakePdfStructuredAdapter,
  createPdfStructuredAdapter,
  defaultRangePayload,
  issueStagedFileHandle,
  pageRangesFor,
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
        probe: { status: "ok", pageCount: 3 },
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
    probe: () => Promise.resolve(config.probe ?? { status: "ok", pageCount: 1 }),
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
      runner: fakeRunner({ probe: { status: "ok", pageCount: 10 } }),
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
    const probe = vi.fn(() => Promise.resolve<ProbeOutcome>({ status: "ok", pageCount: 1 }));
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
      runner: { probe: () => Promise.resolve({ status: "ok", pageCount: 2 }), convertRange },
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
        return { status: "ok", pageCount: 1 };
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

describe("createDoclingRunner", () => {
  it("exposes the runner contract for the real spawn boundary", () => {
    const runner = createDoclingRunner({
      pythonBinary: "python",
      scriptPath: "pdf_to_docling.py",
      perRangeTimeoutMs: 1000,
      memoryMib: 512
    });
    expect(typeof runner.probe).toBe("function");
    expect(typeof runner.convertRange).toBe("function");
  });
});
