// The pure PDF-usability rubric and corpus gate (#705). "Supported" PDF ingestion is measured by the
// USABILITY of the canonical hierarchy each file imports into — never by parser exit, page count, or
// visual rendering. This module is the single, falsifiable source of truth for that judgement: given the
// signals the reproducible corpus harness (scripts/probes/pdfUsabilityHarness.mjs) collects by driving
// the real conversion + canonical mapping, it decides each file's class and whether the 95% gate holds.
//
// It owns NO I/O: SHA-256 dedupe, corpus discovery, worker execution, timing, and memory sampling live in
// the harness. The rubric is a total function of the recorded signals so the gate cannot be moved by a
// subjective read, and so a planted bug in a threshold or a mapping-outcome branch fails a unit test.
// Pure and dependency-free (no React, Fastify, PostgreSQL, or fs): every rule is unit-testable in
// isolation, and the harness reuses the very same verdicts it exercises here.

// The corpus gate: at least 95% of the deduplicated, in-bound pressure corpus must import into a
// materially usable canonical Work without administrator edits. The target is a product claim, not a
// harness convenience, so it lives here as a named constant rather than a magic number in the harness.
export const PDF_USABILITY_GATE_RATIO = 0.95;

// A mapped Work is only "automatic usable" when the extractor's fallible constructs stay a small
// minority: too many mapper-fallback (`unknown`) blocks or too many low-confidence blocks means the
// hierarchy still needs correction before it reads cleanly, so the file is `correctable`, not automatic.
// These proxies make "materially usable without edits" measurable instead of asserted.
export const MAX_AUTOMATIC_UNKNOWN_BLOCK_RATIO = 0.1;
export const MAX_AUTOMATIC_LOW_CONFIDENCE_RATIO = 0.25;

// #817: the OLD proxies above are inert on real books — a mapper default makes `confidence` a constant
// 1.00, and furniture-shaped text simply never became an `unknown` block — so a document that is a
// quarter running-head debris with a completely flat outline still passed. These thresholds compare the
// mapped body against the PDF's OWN text layer and its OWN declared outline instead: an external,
// falsifiable reference neither proxy depends on.
//
// Document-level text coverage: mapped (whitespace-stripped) body characters over native (whitespace-
// stripped) text-layer characters, summed across every MEASURED page (a page whose `nativeTextLength`
// the worker recorded — #701/#817). Below this floor, the body is missing enough of the source's own
// text that automatic import cannot be trusted.
export const MIN_DOCUMENT_TEXT_COVERAGE_RATIO = 0.9;
// One page's own coverage floor — independent of the document-wide ratio, so a few badly-mapped pages
// cannot hide behind an otherwise-strong average.
export const MIN_PAGE_TEXT_COVERAGE_RATIO = 0.8;
// How many of the measured pages may fall below the per-page floor before the document itself is
// unreliable, not just a couple of unlucky pages.
export const MAX_LOW_COVERAGE_PAGE_RATIO = 0.05;
// Furniture over-exclusion/under-exclusion is measured two ways, either of which is contamination:
// too many SURVIVING blocks whose docling label was a furniture candidate (running heads that were kept
// because they looked unique, but in bulk still read as layout debris), or too much of the native text
// layer removed as furniture (an aggressive false-positive exclusion pattern deleting real prose).
export const MAX_ADMITTED_FURNITURE_BLOCK_RATIO = 0.02;
export const MAX_EXCLUDED_FURNITURE_CHARACTER_RATIO = 0.1;
// A source outline this deep is a real, multi-level hierarchy (#815): when the mapped body's own
// deepest heading never reaches this depth, the document's declared structure was NOT carried into the
// canonical Work, whatever the label-derived headings suggest.
export const MIN_STRUCTURED_OUTLINE_DEPTH = 2;
export const MIN_STRUCTURED_BODY_HEADING_LEVEL = 2;

// The three usability classes. `automatic-usable` counts toward the 95% gate; `correctable` is a
// non-automatic result whose canonical text is recoverable through the shared correction workflow
// (#762/#763); `unsupported` produced no usable canonical text at all (crash, timeout, memory, OCR-less
// scan, or empty body) and therefore counts AGAINST the gate rather than creating an empty-shell Work.
export type PdfUsabilityClass = "automatic-usable" | "correctable" | "unsupported";

// One primary reason per verdict, so the aggregate report exposes the remaining correction workload and
// the failure shapes worth converting into regression fixtures — never a bare pass/fail number.
export type PdfUsabilityReason =
  | "clean-canonical-work"
  | "unmapped-constructs"
  | "low-confidence-extraction"
  | "ocr-required"
  | "empty-body"
  | "image-unsupported"
  | "conversion-failed"
  // The converter returned a TRUNCATED book rather than failing: pages were dropped and the import was
  // refused (#832). Kept distinct from `conversion-failed` on purpose — this report is aggregate-only, so a
  // reason folded into the generic bucket is invisible, and truncation is precisely the shape a resource
  // ceiling produces and the one worth converting into a fixture.
  | "incomplete-conversion"
  | "timed-out"
  | "memory-exhausted"
  // #817: the mapped body omits too much of the PDF's own text layer, either document-wide or on too
  // many individual pages — see MIN_DOCUMENT_TEXT_COVERAGE_RATIO / MIN_PAGE_TEXT_COVERAGE_RATIO /
  // MAX_LOW_COVERAGE_PAGE_RATIO.
  | "low-text-coverage"
  // #817: too much surviving furniture-candidate text, or too much of the native text layer was removed
  // as furniture — see MAX_ADMITTED_FURNITURE_BLOCK_RATIO / MAX_EXCLUDED_FURNITURE_CHARACTER_RATIO.
  | "furniture-contamination"
  // #817: the source PDF declares a real multi-level outline, but the mapped body's own heading depth
  // never followed it down — see MIN_STRUCTURED_OUTLINE_DEPTH / MIN_STRUCTURED_BODY_HEADING_LEVEL.
  | "flat-outline"
  // #817: the document has pages the worker never measured a native text length for (an older cached
  // range payload, or a probe path that does not record it), so text-coverage rules cannot be evaluated
  // at all. Distinct from `low-text-coverage` — this is "unknown", not "known bad".
  | "coverage-unmeasured";

// The usability signals distilled from ONE mapped canonical Work (#702's `mapStructuredDocument`
// projection). The harness computes these from the real mapping result; the rubric reads only these
// numbers so it stays pure and the thresholds are the sole knobs.
export type MappedWorkSummary = Readonly<{
  // Total persisted canonical blocks across every reading unit (>= 1 for a mapped Work).
  blockCount: number;
  // Canonical heading nodes — the Outline/ReadingUnit spine that makes navigation and correction workable.
  headingCount: number;
  // Blocks that took the mapper's `unknown`/fallback path (an unrecognized construct or empty table/list).
  unknownBlockCount: number;
  // Blocks whose retained extraction confidence is below PDF_EXTRACTION_CONFIDENCE_THRESHOLD.
  lowConfidenceBlockCount: number;
  // Unresolved picture/figure placeholders in the Work (#806): pictures whose image bytes are not yet
  // extracted. A positive count makes the Work `correctable` (an administrator supplies the images later),
  // never `automatic-usable`.
  unresolvedFigureCount: number;
  // Readable body code points across all blocks; 0 means a mapped-but-textless shell.
  plainTextLength: number;
  // #817: per-page text-layer coverage, one entry per page the mapped Work drew content from.
  // `nativeTextLength` is the worker's whitespace-stripped count of the PDF's OWN text layer for that
  // page (StructuredPage#nativeTextLength — #701), or `null` when the worker did not record it (an
  // older cached range payload). `mappedCharacters` is the whitespace-stripped canonical body text the
  // mapper attributed to that page. A page missing from this list was never measured at all.
  pageTextCoverage: readonly Readonly<{
    page: number;
    nativeTextLength: number | null;
    mappedCharacters: number;
  }>[];
  // Surviving readable blocks whose docling label was a furniture candidate (page_header/page_footer)
  // but were admitted into the body because they read as unique running text (#817's mapper-side count,
  // alongside the pre-existing `excludedFurnitureCount`/`excludedFurnitureCharacters` below).
  admittedFurnitureCandidateBlockCount: number;
  // Native text-layer characters the mapper excluded as page furniture (headers/footers) — the character
  // counterpart to the pre-existing `excludedFurnitureCount` (block counterpart), so over-exclusion is
  // measurable against the text layer's own size, not just a block tally.
  excludedFurnitureCharacters: number;
  // Deepest canonical heading level actually produced in the mapped body (0 when the Work has no
  // headings at all).
  deepestHeadingLevel: number;
  // Deepest level declared by the PDF's OWN outline/bookmarks (StructuredDocument#outline — #815), 0 when
  // the source PDF has no outline.
  sourceOutlineDepth: number;
}>;

// The typed outcome of running one corpus PDF through the supported import pipeline, reduced to what the
// rubric needs. `corrupt`/`password_required` are handled by eligibility (excluded from the denominator);
// every other kind is classifiable. A mapped Work carrying unresolved figures is NOT a separate kind — it
// is a `mapped` observation whose summary counts them (#806), so it stays a real, published Work.
export type ClassifiableObservation =
  | Readonly<{ kind: "mapped"; summary: MappedWorkSummary }>
  | Readonly<{ kind: "ocr_required"; pagesNeedingOcr: number }>
  | Readonly<{ kind: "no_content" }>
  | Readonly<{ kind: "conversion_failed"; detail: string }>
  // The converter refused a run that returned a fragment of the book rather than the book (#832). No page
  // count travels with it: the worker's status gate refuses BEFORE a payload exists, so all the harness
  // has is the exit code — and completeness is never inferred from what pages produced (`docs/DECISIONS.md`
  // D8), so no count could be derived here either.
  | Readonly<{ kind: "incomplete_conversion" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "memory" }>;

export type PdfImportObservation =
  | ClassifiableObservation
  | Readonly<{ kind: "corrupt" }>
  | Readonly<{ kind: "password_required" }>;

export type PdfUsabilityVerdict = Readonly<{
  class: PdfUsabilityClass;
  reason: PdfUsabilityReason;
}>;

// Classify one CLASSIFIABLE file (eligibility has already excluded corrupt/password/out-of-bound inputs).
// A mapped Work is automatic only when its fallback and low-confidence blocks stay a small minority AND
// it carries readable text; otherwise the text is recoverable through correction (`correctable`). A
// refusal that preserved no usable text is `unsupported` and counts against the gate.
export function classifyPdfUsability(observation: ClassifiableObservation): PdfUsabilityVerdict {
  switch (observation.kind) {
    case "mapped":
      return classifyMappedWork(observation.summary);
    case "ocr_required":
      return { class: "unsupported", reason: "ocr-required" };
    case "no_content":
      return { class: "unsupported", reason: "empty-body" };
    case "conversion_failed":
      return { class: "unsupported", reason: "conversion-failed" };
    case "incomplete_conversion":
      return { class: "unsupported", reason: "incomplete-conversion" };
    case "timeout":
      return { class: "unsupported", reason: "timed-out" };
    case "memory":
      return { class: "unsupported", reason: "memory-exhausted" };
  }
}

function classifyMappedWork(summary: MappedWorkSummary): PdfUsabilityVerdict {
  // A mapped Work always has at least one block, but a body of only `unknown`/textless nodes yields no
  // readable content: it is recoverable by retyping, so it is `correctable`, never automatic.
  if (summary.plainTextLength === 0) {
    return { class: "correctable", reason: "unmapped-constructs" };
  }
  // An unresolved figure placeholder (#806) means the Work published its readable text but still needs an
  // administrator to supply the image bytes, so it is `correctable` (never counted as automatic) and its
  // reason names the image gap. This keeps a `correctable`/`image-unsupported` verdict corresponding to a
  // real, published Work.
  if (summary.unresolvedFigureCount > 0) {
    return { class: "correctable", reason: "image-unsupported" };
  }
  const unknownRatio = summary.unknownBlockCount / summary.blockCount;
  if (unknownRatio > MAX_AUTOMATIC_UNKNOWN_BLOCK_RATIO) {
    return { class: "correctable", reason: "unmapped-constructs" };
  }
  const lowConfidenceRatio = summary.lowConfidenceBlockCount / summary.blockCount;
  if (lowConfidenceRatio > MAX_AUTOMATIC_LOW_CONFIDENCE_RATIO) {
    return { class: "correctable", reason: "low-confidence-extraction" };
  }

  // #817: the checks above are label/confidence proxies that stay quiet on furniture-heavy or
  // flat-outline books (see the thresholds' own doc comment). These compare the mapped body against the
  // PDF's OWN text layer and outline instead, and run only once the mapped Work has already cleared every
  // check above.
  const measuredPages = summary.pageTextCoverage.filter(
    (page): page is { page: number; nativeTextLength: number; mappedCharacters: number } =>
      page.nativeTextLength !== null
  );
  if (measuredPages.length === 0) {
    return { class: "correctable", reason: "coverage-unmeasured" };
  }
  const totalNativeLength = measuredPages.reduce((sum, page) => sum + page.nativeTextLength, 0);
  const totalMappedLength = measuredPages.reduce((sum, page) => sum + page.mappedCharacters, 0);
  // A page can be legitimately text-less (a plate, a blank leaf): zero native text contributes nothing to
  // either sum, so it can neither help nor hurt the ratio.
  const documentCoverageRatio = totalNativeLength === 0 ? 1 : totalMappedLength / totalNativeLength;
  if (documentCoverageRatio < MIN_DOCUMENT_TEXT_COVERAGE_RATIO) {
    return { class: "correctable", reason: "low-text-coverage" };
  }
  const lowCoveragePageCount = measuredPages.filter((page) => {
    if (page.nativeTextLength === 0) {
      return false;
    }
    return page.mappedCharacters / page.nativeTextLength < MIN_PAGE_TEXT_COVERAGE_RATIO;
  }).length;
  if (lowCoveragePageCount / measuredPages.length > MAX_LOW_COVERAGE_PAGE_RATIO) {
    return { class: "correctable", reason: "low-text-coverage" };
  }
  const admittedFurnitureBlockRatio =
    summary.admittedFurnitureCandidateBlockCount / summary.blockCount;
  const excludedFurnitureCharacterRatio =
    totalNativeLength === 0 ? 0 : summary.excludedFurnitureCharacters / totalNativeLength;
  if (
    admittedFurnitureBlockRatio > MAX_ADMITTED_FURNITURE_BLOCK_RATIO ||
    excludedFurnitureCharacterRatio > MAX_EXCLUDED_FURNITURE_CHARACTER_RATIO
  ) {
    return { class: "correctable", reason: "furniture-contamination" };
  }
  // A real multi-level source outline whose depth the mapped body never reached, or a source outline
  // that exists at all while the mapped body produced NO headings whatsoever: either way the document's
  // own declared structure did not make it into the canonical Work.
  const flatOutline =
    (summary.sourceOutlineDepth >= MIN_STRUCTURED_OUTLINE_DEPTH &&
      summary.deepestHeadingLevel < MIN_STRUCTURED_BODY_HEADING_LEVEL) ||
    (summary.headingCount === 0 && summary.sourceOutlineDepth > 0);
  if (flatOutline) {
    return { class: "correctable", reason: "flat-outline" };
  }

  return { class: "automatic-usable", reason: "clean-canonical-work" };
}

// Why a deduplicated file is not in the 95% denominator. Out-of-bound, corrupt, and password-required
// files are declared unsupported INPUTS, excluded from the denominator rather than hidden successes; a
// zero-text conversion failure is NOT excluded — it stays in the denominator as `unsupported`.
export type CorpusExclusionReason = "over-size" | "over-pages" | "corrupt" | "password-required";

export type CorpusEligibility =
  | Readonly<{ included: true }>
  | Readonly<{ included: false; reason: CorpusExclusionReason }>;

// The declared resource bounds (mirrors @whetstone/contracts MAX_STAGED_BYTES / MAX_PAGE_COUNT). Passed
// in so the pure rubric keeps no dependency on the contracts package; the harness supplies the pinned
// values so a bound change moves in one place.
export type CorpusBounds = Readonly<{ maxBytes: number; maxPages: number }>;

export type PdfCorpusFileFacts = Readonly<{
  sizeBytes: number;
  // The declared page count, or null when the file was too corrupt to probe (a corrupt input anyway).
  pageCount: number | null;
}>;

// Decide whether a deduplicated file belongs in the 95% denominator. Bounds are checked first (an
// oversized or absurd-page file is out of scope regardless of what conversion did), then the corrupt /
// password-required inputs conversion demonstrated.
export function assessCorpusEligibility(
  facts: PdfCorpusFileFacts,
  observation: PdfImportObservation,
  bounds: CorpusBounds
): CorpusEligibility {
  if (facts.sizeBytes > bounds.maxBytes) {
    return { included: false, reason: "over-size" };
  }
  if (facts.pageCount !== null && facts.pageCount > bounds.maxPages) {
    return { included: false, reason: "over-pages" };
  }
  if (observation.kind === "corrupt") {
    return { included: false, reason: "corrupt" };
  }
  if (observation.kind === "password_required") {
    return { included: false, reason: "password-required" };
  }
  return { included: true };
}

// Safe per-file timing/memory/page metrics recorded by the harness (never any content).
export type PdfCaseMetrics = Readonly<{
  elapsedMs: number;
  // Peak worker RSS in MiB, or null when the platform did not sample it (e.g. win32).
  peakMemoryMib: number | null;
  pageCount: number | null;
}>;

export type CorpusCaseInput = Readonly<{
  caseId: string;
  facts: PdfCorpusFileFacts;
  observation: PdfImportObservation;
  metrics: PdfCaseMetrics;
  bounds: CorpusBounds;
}>;

export type CorpusCaseResult = Readonly<{
  caseId: string;
  eligibility: CorpusEligibility;
  // The usability verdict, or null when the file is excluded from the denominator.
  verdict: PdfUsabilityVerdict | null;
  metrics: PdfCaseMetrics;
}>;

// Evaluate one deduplicated corpus file end to end: eligibility, then (for an included file) its
// usability verdict. An excluded file carries no verdict — it is not a success or a failure of the gate,
// it is out of the denominator.
export function evaluateCorpusCase(input: CorpusCaseInput): CorpusCaseResult {
  const eligibility = assessCorpusEligibility(input.facts, input.observation, input.bounds);
  if (!eligibility.included) {
    return { caseId: input.caseId, eligibility, metrics: input.metrics, verdict: null };
  }
  // Eligibility already excluded corrupt/password, so the observation is classifiable here.
  const classifiable = input.observation as ClassifiableObservation;
  return {
    caseId: input.caseId,
    eligibility,
    metrics: input.metrics,
    verdict: classifyPdfUsability(classifiable)
  };
}

export type LatencySummary = Readonly<{ p50: number; p90: number; max: number }>;

const EXCLUSION_REASONS: readonly CorpusExclusionReason[] = [
  "over-size",
  "over-pages",
  "corrupt",
  "password-required"
];

const USABILITY_CLASSES: readonly PdfUsabilityClass[] = [
  "automatic-usable",
  "correctable",
  "unsupported"
];

const USABILITY_REASONS: readonly PdfUsabilityReason[] = [
  "clean-canonical-work",
  "unmapped-constructs",
  "low-confidence-extraction",
  "ocr-required",
  "empty-body",
  "image-unsupported",
  "conversion-failed",
  "incomplete-conversion",
  "timed-out",
  "memory-exhausted",
  "low-text-coverage",
  "furniture-contamination",
  "flat-outline",
  "coverage-unmeasured"
];

export type CorpusReport = Readonly<{
  // Deduplicated files evaluated (the raw corpus size after SHA-256 dedupe).
  totalFiles: number;
  excluded: Readonly<Record<CorpusExclusionReason, number>>;
  // In-bound, non-corrupt, non-password files: the 95% denominator.
  denominator: number;
  classCounts: Readonly<Record<PdfUsabilityClass, number>>;
  reasonCounts: Readonly<Record<PdfUsabilityReason, number>>;
  // automatic-usable / denominator, or 0 when the denominator is empty.
  automaticUsableRatio: number;
  gatePass: boolean;
  // Wall-time distribution over the included cases.
  timing: LatencySummary;
  // Max sampled peak worker memory across included cases, or null when nothing was sampled.
  peakMemoryMib: number | null;
}>;

// The q-quantile (0..1) of an ascending-sorted array by nearest-rank, or 0 for an empty array.
function percentile(sortedAsc: readonly number[], quantile: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const rank = Math.ceil(quantile * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index]!;
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

// Aggregate every evaluated case into the committable report: exclusion and class/reason histograms, the
// 95% ratio and gate verdict, timing percentiles, and peak memory. The gate holds only when the
// denominator is non-empty AND the automatic-usable ratio reaches the target, so an empty corpus can
// never trivially "pass".
export function summarizeCorpus(cases: readonly CorpusCaseResult[]): CorpusReport {
  const excluded = zeroed(EXCLUSION_REASONS);
  const classCounts = zeroed(USABILITY_CLASSES);
  const reasonCounts = zeroed(USABILITY_REASONS);
  const includedTimings: number[] = [];
  let peakMemoryMib: number | null = null;

  for (const result of cases) {
    if (!result.eligibility.included) {
      excluded[result.eligibility.reason] += 1;
      continue;
    }
    const verdict = result.verdict!;
    classCounts[verdict.class] += 1;
    reasonCounts[verdict.reason] += 1;
    includedTimings.push(result.metrics.elapsedMs);
    if (result.metrics.peakMemoryMib !== null) {
      peakMemoryMib = Math.max(peakMemoryMib ?? 0, result.metrics.peakMemoryMib);
    }
  }

  const denominator = includedTimings.length;
  const automaticUsableRatio =
    denominator === 0 ? 0 : classCounts["automatic-usable"] / denominator;
  const sorted = [...includedTimings].sort((a, b) => a - b);

  return {
    automaticUsableRatio,
    classCounts,
    denominator,
    excluded,
    gatePass: denominator > 0 && automaticUsableRatio >= PDF_USABILITY_GATE_RATIO,
    peakMemoryMib,
    reasonCounts,
    timing: {
      max: percentile(sorted, 1),
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9)
    },
    totalFiles: cases.length
  };
}
