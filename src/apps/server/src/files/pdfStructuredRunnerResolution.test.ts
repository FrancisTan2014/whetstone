import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS
} from "@whetstone/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { STRUCTURED_PDF_FIXTURE_MARKER } from "./pdfStructuredAdapter.js";
import { resolveStructuredPdfRunner } from "./pdfStructuredRunnerResolution.js";

const supportedVersion = SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS[0]!;
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function writeFixtureFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-resolver-"));
  cleanupDirs.push(dir);
  const path = join(dir, "fixture.pdf");
  const conversion = JSON.stringify({
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema: { name: "DoclingDocument", version: supportedVersion },
    pages: [{ pageNumber: 1, hasNativeText: true }],
    body: [
      {
        label: "text",
        pageNumber: 1,
        boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
        charSpan: [0, 4],
        confidence: 1,
        text: "page 1",
        children: []
      }
    ],
    furniture: []
  });
  await writeFile(path, `%PDF-1.7\n${STRUCTURED_PDF_FIXTURE_MARKER}\n${conversion}`);
  return path;
}

const baseResolution = {
  fixtureConversion: false,
  pythonBinary: "python",
  scriptPath: "pdf_to_docling.py",
  perRangeTimeoutMs: 1000,
  memoryMib: 512
} as const;

describe("resolveStructuredPdfRunner", () => {
  it("selects the staged-bytes fixture backend when fixture conversion is enabled", async () => {
    // The fixture backend reads the ACTUAL staged bytes, so probing the embedded fixture yields its
    // page count — proving this branch is input-derived, not the canned or unavailable runner.
    const runner = resolveStructuredPdfRunner({ ...baseResolution, fixtureConversion: true });
    const path = await writeFixtureFile();
    expect(await runner.probe(path, undefined)).toEqual({ status: "ok", pageCount: 1 });
  });

  it("fails visibly on a platform where the memory ceiling cannot be enforced", async () => {
    // Windows cannot enforce the per-child memory ceiling, so the real runner cannot construct there;
    // the resolver must fall back to the fail-visibly runner rather than fabricate content.
    const runner = resolveStructuredPdfRunner({ ...baseResolution, platform: "win32" });
    expect(await runner.probe("Q:/stage/any.pdf", undefined)).toEqual({ status: "tool_missing" });
    const outcome = await runner.convertRange("Q:/stage/any.pdf", 1, 1, undefined);
    expect(outcome.status).toBe("failure");
    if (outcome.status !== "failure") throw new Error("expected a failure outcome");
    expect(outcome.failure.kind).toBe("tool_missing");
  });

  it("selects the real Docling runner on a platform that can enforce the ceiling", () => {
    // On POSIX the resolver constructs the real #701 runner (which self-reports tool_missing per attempt
    // when the toolchain is absent). It must construct without throwing and expose the runner surface.
    const runner = resolveStructuredPdfRunner({ ...baseResolution, platform: "linux" });
    expect(typeof runner.probe).toBe("function");
    expect(typeof runner.convertRange).toBe("function");
  });

  it("defaults to the host platform when none is injected", () => {
    // Exercises the `?? process.platform` fallback: with no explicit platform the resolver still returns a
    // usable runner surface (the real runner on POSIX hosts, the fail-visibly runner on Windows).
    const runner = resolveStructuredPdfRunner(baseResolution);
    expect(typeof runner.probe).toBe("function");
    expect(typeof runner.convertRange).toBe("function");
  });
});
