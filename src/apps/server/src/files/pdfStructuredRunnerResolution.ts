import {
  canEnforceStructuredPdfMemoryCeiling,
  createDoclingRunner,
  createStagedFixtureDoclingRunner,
  createUnavailableDoclingRunner,
  type DoclingRunner
} from "./pdfStructuredAdapter.js";

// Resolve the structured PDF conversion backend the born-digital import worker (#702) drives, honestly
// and absent-config-safe. The composition root NEVER wires a canned in-memory runner here: a user upload
// must either be converted from its own bytes or fail visibly, never published as fabricated content.
//
// Three outcomes, in priority order:
//   1. Fixture backend — only when `PDF_IMPORT_FIXTURE_CONVERSION` is set (dev/E2E). It reads the ACTUAL
//      staged bytes and converts an embedded RangeConversion fixture, so the born-digital journey can be
//      exercised deterministically without a Python/Docling install. Off in production.
//   2. Real Docling runner — on a platform where the per-child memory ceiling can be enforced. When the
//      pinned toolchain is not provisioned it self-reports `tool_missing` per attempt (fail visibly),
//      so nothing canned is ever published.
//   3. Unavailable runner — on an unsupported platform (e.g. Windows) where the bounded real runner
//      cannot even construct. Every attempt fails visibly with `tool_missing`.
export type StructuredPdfRunnerResolution = Readonly<{
  // Enable the deterministic staged-bytes fixture backend (dev/E2E only). Never true in production.
  fixtureConversion: boolean;
  pythonBinary: string;
  scriptPath: string;
  perRangeTimeoutMs: number;
  memoryMib: number;
  // Injected so platform selection is testable; defaults to the host platform.
  platform?: NodeJS.Platform;
}>;

export function resolveStructuredPdfRunner(
  resolution: StructuredPdfRunnerResolution
): DoclingRunner {
  if (resolution.fixtureConversion) {
    return createStagedFixtureDoclingRunner();
  }

  const platform = resolution.platform ?? process.platform;
  if (!canEnforceStructuredPdfMemoryCeiling(platform)) {
    return createUnavailableDoclingRunner();
  }

  return createDoclingRunner({
    pythonBinary: resolution.pythonBinary,
    scriptPath: resolution.scriptPath,
    perRangeTimeoutMs: resolution.perRangeTimeoutMs,
    memoryMib: resolution.memoryMib,
    platform
  });
}
