import { describe, expect, it } from "vitest";

import {
  assessCorpusEligibility,
  classifyPdfUsability,
  evaluateCorpusCase,
  PDF_USABILITY_GATE_RATIO,
  summarizeCorpus
} from "./pdfUsability.js";
import type {
  ClassifiableObservation,
  CorpusBounds,
  CorpusCaseInput,
  CorpusCaseResult,
  MappedWorkSummary,
  PdfCaseMetrics
} from "./pdfUsability.js";

const BOUNDS: CorpusBounds = { maxBytes: 128 * 1024 * 1024, maxPages: 3000 };

// A clean mapped Work: readable text, no fallback blocks, all high-confidence.
function cleanSummary(overrides: Partial<MappedWorkSummary> = {}): MappedWorkSummary {
  return {
    blockCount: 20,
    headingCount: 4,
    lowConfidenceBlockCount: 0,
    plainTextLength: 5000,
    unknownBlockCount: 0,
    unresolvedFigureCount: 0,
    ...overrides
  };
}

function metrics(overrides: Partial<PdfCaseMetrics> = {}): PdfCaseMetrics {
  return { elapsedMs: 1000, pageCount: 10, peakMemoryMib: 256, ...overrides };
}

function includedCase(
  observation: ClassifiableObservation,
  overrides: Partial<CorpusCaseInput> = {}
): CorpusCaseResult {
  return evaluateCorpusCase({
    bounds: BOUNDS,
    caseId: "case-1",
    facts: { pageCount: 10, sizeBytes: 1024 },
    metrics: metrics(),
    observation,
    ...overrides
  });
}

describe("classifyPdfUsability", () => {
  it("passes a clean mapped Work as automatic usable", () => {
    expect(classifyPdfUsability({ kind: "mapped", summary: cleanSummary() })).toEqual({
      class: "automatic-usable",
      reason: "clean-canonical-work"
    });
  });

  it("marks a mapped Work with too many fallback blocks as correctable", () => {
    // 3/20 = 15% unknown, above the 10% automatic ceiling.
    const verdict = classifyPdfUsability({
      kind: "mapped",
      summary: cleanSummary({ unknownBlockCount: 3 })
    });
    expect(verdict).toEqual({ class: "correctable", reason: "unmapped-constructs" });
  });

  it("keeps a mapped Work at exactly the unknown ceiling automatic", () => {
    // 2/20 = 10% unknown, exactly at the ceiling (not above).
    expect(
      classifyPdfUsability({ kind: "mapped", summary: cleanSummary({ unknownBlockCount: 2 }) })
        .class
    ).toBe("automatic-usable");
  });

  it("marks a low-confidence-heavy mapped Work as correctable", () => {
    // 6/20 = 30% low confidence, above the 25% ceiling.
    const verdict = classifyPdfUsability({
      kind: "mapped",
      summary: cleanSummary({ lowConfidenceBlockCount: 6 })
    });
    expect(verdict).toEqual({ class: "correctable", reason: "low-confidence-extraction" });
  });

  it("keeps a mapped Work at exactly the low-confidence ceiling automatic", () => {
    // 5/20 = 25% low confidence, exactly at the ceiling.
    expect(
      classifyPdfUsability({
        kind: "mapped",
        summary: cleanSummary({ lowConfidenceBlockCount: 5 })
      }).class
    ).toBe("automatic-usable");
  });

  it("treats a mapped-but-textless shell as correctable", () => {
    const verdict = classifyPdfUsability({
      kind: "mapped",
      summary: cleanSummary({ plainTextLength: 0 })
    });
    expect(verdict).toEqual({ class: "correctable", reason: "unmapped-constructs" });
  });

  it("routes a mapped Work carrying an unresolved figure into the correction workflow (#806)", () => {
    const verdict = classifyPdfUsability({
      kind: "mapped",
      summary: cleanSummary({ unresolvedFigureCount: 1 })
    });
    expect(verdict).toEqual({ class: "correctable", reason: "image-unsupported" });
  });

  it("counts a scan needing OCR as unsupported", () => {
    expect(classifyPdfUsability({ kind: "ocr_required", pagesNeedingOcr: 5 })).toEqual({
      class: "unsupported",
      reason: "ocr-required"
    });
  });

  it("counts an empty body as unsupported", () => {
    expect(classifyPdfUsability({ kind: "no_content" })).toEqual({
      class: "unsupported",
      reason: "empty-body"
    });
  });

  it("counts a conversion failure as unsupported", () => {
    expect(classifyPdfUsability({ kind: "conversion_failed", detail: "boom" })).toEqual({
      class: "unsupported",
      reason: "conversion-failed"
    });
  });

  it("counts a timeout as unsupported", () => {
    expect(classifyPdfUsability({ kind: "timeout" })).toEqual({
      class: "unsupported",
      reason: "timed-out"
    });
  });

  it("counts a memory breach as unsupported", () => {
    expect(classifyPdfUsability({ kind: "memory" })).toEqual({
      class: "unsupported",
      reason: "memory-exhausted"
    });
  });
});

describe("assessCorpusEligibility", () => {
  it("includes an in-bound, convertible file", () => {
    expect(
      assessCorpusEligibility(
        { pageCount: 100, sizeBytes: 1024 },
        { kind: "mapped", summary: cleanSummary() },
        BOUNDS
      )
    ).toEqual({ included: true });
  });

  it("excludes an oversized file before anything else", () => {
    expect(
      assessCorpusEligibility(
        { pageCount: 1, sizeBytes: BOUNDS.maxBytes + 1 },
        { kind: "corrupt" },
        BOUNDS
      )
    ).toEqual({ included: false, reason: "over-size" });
  });

  it("excludes a file over the page bound", () => {
    expect(
      assessCorpusEligibility(
        { pageCount: BOUNDS.maxPages + 1, sizeBytes: 1024 },
        { kind: "mapped", summary: cleanSummary() },
        BOUNDS
      )
    ).toEqual({ included: false, reason: "over-pages" });
  });

  it("does not exclude on page bound when the page count is unknown", () => {
    expect(
      assessCorpusEligibility({ pageCount: null, sizeBytes: 1024 }, { kind: "corrupt" }, BOUNDS)
    ).toEqual({ included: false, reason: "corrupt" });
  });

  it("excludes a corrupt file", () => {
    expect(
      assessCorpusEligibility({ pageCount: 10, sizeBytes: 1024 }, { kind: "corrupt" }, BOUNDS)
    ).toEqual({ included: false, reason: "corrupt" });
  });

  it("excludes a password-required file", () => {
    expect(
      assessCorpusEligibility(
        { pageCount: 10, sizeBytes: 1024 },
        { kind: "password_required" },
        BOUNDS
      )
    ).toEqual({ included: false, reason: "password-required" });
  });
});

describe("evaluateCorpusCase", () => {
  it("yields no verdict for an excluded file", () => {
    const result = evaluateCorpusCase({
      bounds: BOUNDS,
      caseId: "case-x",
      facts: { pageCount: 10, sizeBytes: 1024 },
      metrics: metrics(),
      observation: { kind: "corrupt" }
    });
    expect(result.verdict).toBeNull();
    expect(result.eligibility).toEqual({ included: false, reason: "corrupt" });
  });

  it("yields a verdict for an included file", () => {
    const result = includedCase({ kind: "mapped", summary: cleanSummary() });
    expect(result.eligibility).toEqual({ included: true });
    expect(result.verdict).toEqual({ class: "automatic-usable", reason: "clean-canonical-work" });
  });
});

describe("summarizeCorpus", () => {
  it("reports zero and fails the gate for an empty corpus", () => {
    const report = summarizeCorpus([]);
    expect(report.totalFiles).toBe(0);
    expect(report.denominator).toBe(0);
    expect(report.automaticUsableRatio).toBe(0);
    expect(report.gatePass).toBe(false);
    expect(report.timing).toEqual({ max: 0, p50: 0, p90: 0 });
    expect(report.peakMemoryMib).toBeNull();
  });

  it("passes the gate at exactly 95% automatic usable", () => {
    const cases: CorpusCaseResult[] = [];
    for (let i = 0; i < 19; i += 1) {
      cases.push(includedCase({ kind: "mapped", summary: cleanSummary() }));
    }
    cases.push(includedCase({ kind: "ocr_required", pagesNeedingOcr: 3 }));
    const report = summarizeCorpus(cases);
    expect(report.denominator).toBe(20);
    expect(report.classCounts["automatic-usable"]).toBe(19);
    expect(report.classCounts.unsupported).toBe(1);
    expect(report.automaticUsableRatio).toBe(PDF_USABILITY_GATE_RATIO);
    expect(report.gatePass).toBe(true);
  });

  it("fails the gate below 95% and keeps zero-text failures in the denominator", () => {
    const cases: CorpusCaseResult[] = [];
    for (let i = 0; i < 18; i += 1) {
      cases.push(includedCase({ kind: "mapped", summary: cleanSummary() }));
    }
    cases.push(includedCase({ kind: "no_content" }));
    cases.push(includedCase({ kind: "conversion_failed", detail: "x" }));
    const report = summarizeCorpus(cases);
    expect(report.denominator).toBe(20);
    expect(report.automaticUsableRatio).toBeCloseTo(0.9);
    expect(report.gatePass).toBe(false);
    expect(report.reasonCounts["empty-body"]).toBe(1);
    expect(report.reasonCounts["conversion-failed"]).toBe(1);
  });

  it("counts excluded files without letting them shrink the denominator", () => {
    const excludedCorrupt = evaluateCorpusCase({
      bounds: BOUNDS,
      caseId: "c",
      facts: { pageCount: 10, sizeBytes: 1024 },
      metrics: metrics(),
      observation: { kind: "corrupt" }
    });
    const excludedOversize = evaluateCorpusCase({
      bounds: BOUNDS,
      caseId: "o",
      facts: { pageCount: 1, sizeBytes: BOUNDS.maxBytes + 1 },
      metrics: metrics(),
      observation: { kind: "mapped", summary: cleanSummary() }
    });
    const report = summarizeCorpus([
      includedCase({ kind: "mapped", summary: cleanSummary() }),
      excludedCorrupt,
      excludedOversize
    ]);
    expect(report.totalFiles).toBe(3);
    expect(report.denominator).toBe(1);
    expect(report.excluded.corrupt).toBe(1);
    expect(report.excluded["over-size"]).toBe(1);
    expect(report.gatePass).toBe(true);
  });

  it("summarizes timing percentiles and peak memory over included cases", () => {
    const elapsed = [10, 20, 30, 40, 100];
    const cases = elapsed.map((ms, i) =>
      includedCase(
        { kind: "mapped", summary: cleanSummary() },
        {
          caseId: `case-${i}`,
          metrics: metrics({ elapsedMs: ms, peakMemoryMib: ms === 100 ? 900 : 100 })
        }
      )
    );
    const report = summarizeCorpus(cases);
    expect(report.timing.max).toBe(100);
    expect(report.timing.p50).toBe(30);
    expect(report.timing.p90).toBe(100);
    expect(report.peakMemoryMib).toBe(900);
  });

  it("reports null peak memory when no included case sampled it", () => {
    const report = summarizeCorpus([
      includedCase(
        { kind: "mapped", summary: cleanSummary() },
        { metrics: metrics({ peakMemoryMib: null }) }
      )
    ]);
    expect(report.peakMemoryMib).toBeNull();
  });
});

// Regression fixtures: the smallest synthetic reproduction of each repeated failure shape the harness
// surfaces, pinned so a change to the rubric that would re-classify the shape fails here. New failure
// shapes discovered by a real corpus run are added to this table (never by loosening a threshold).
describe("regression fixtures", () => {
  const fixtures: ReadonlyArray<{
    name: string;
    observation: ClassifiableObservation;
    expected: { class: string; reason: string };
  }> = [
    {
      expected: { class: "correctable", reason: "unmapped-constructs" },
      // A scanned table-of-contents page docling emits mostly as unrecognized constructs: text is
      // recoverable by retyping, so the file must stay correctable, never silently automatic.
      name: "fallback-heavy table of contents",
      observation: {
        kind: "mapped",
        summary: cleanSummary({ blockCount: 10, unknownBlockCount: 4 })
      }
    },
    {
      expected: { class: "unsupported", reason: "ocr-required" },
      // A born-image scan with no native text and no OCR pack: no usable canonical text, so it counts
      // against the gate rather than publishing an empty shell.
      name: "textless scan without OCR",
      observation: { kind: "ocr_required", pagesNeedingOcr: 12 }
    },
    {
      expected: { class: "correctable", reason: "image-unsupported" },
      // A text-heavy, otherwise-clean Work that still carries one unresolved figure placeholder (#806):
      // it publishes and reads, but an administrator must supply the image, so the rubric must classify it
      // correctable — never counting it toward the automatic gate.
      name: "readable Work with one unresolved figure",
      observation: {
        kind: "mapped",
        summary: cleanSummary({ unresolvedFigureCount: 1 })
      }
    }
  ];

  for (const fixture of fixtures) {
    it(`classifies ${fixture.name} deterministically`, () => {
      expect(classifyPdfUsability(fixture.observation)).toEqual(fixture.expected);
    });
  }
});
