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
  PdfCaseMetrics,
  PdfUsabilityReason
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

  // #832. A truncated conversion is deliberately NOT folded into `conversion-failed`: the corpus report
  // is aggregate-only (no per-file rows), so a reason that shares a bucket is invisible in the evidence —
  // and truncation is both the shape a resource ceiling produces and the one worth turning into a fixture.
  it("counts an incomplete conversion as unsupported, under its own reason", () => {
    expect(classifyPdfUsability({ kind: "incomplete_conversion" })).toEqual({
      class: "unsupported",
      reason: "incomplete-conversion"
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

// #832/#839. summarizeCorpus pre-seeds a zero counter for every reason in the module-private
// USABILITY_REASONS list (reasonCounts = zeroed(USABILITY_REASONS)), so a reason no case hit still
// appears in the aggregate as 0 instead of vanishing. That safety net only holds if USABILITY_REASONS
// carries EXACTLY the reasons classifyPdfUsability can return: a reason the mapping produces but the
// list omits is under-counted to invisibility (the corpus run silently under-reports the very thing it
// measures — the defect the #839 harness fix was written to prevent), and a reason the list carries but
// the mapping can never produce shows a permanent phantom 0. This block pins USABILITY_REASONS to the
// mapping's real output in BOTH directions, observed through the report itself rather than by exporting
// the private list only to restate it.
describe("USABILITY_REASONS matches the reasons the canonical mapping can produce", () => {
  // The producible set is the reasons classifyPdfUsability ACTUALLY returns, derived by driving the
  // mapping over its input space rather than by hand-listing outputs (which is what let a new mapped
  // sub-branch slip past this pin during review). It has two parts.
  //
  // Part 1 -- every non-`mapped` observation kind. Each is a distinct top-level union variant that maps
  // 1:1 to a fixed reason with no sub-branches, and the production switch in classifyPdfUsability
  // already forces exhaustive handling of the kinds, so a brand-new *kind* is a visible production
  // change that must also be added to this short list (see the residual-gap note on the first test).
  const nonMappedObservations: readonly ClassifiableObservation[] = [
    { kind: "ocr_required", pagesNeedingOcr: 3 },
    { kind: "no_content" },
    { kind: "conversion_failed", detail: "x" },
    { kind: "incomplete_conversion" },
    { kind: "timeout" },
    { kind: "memory" }
  ];

  // Part 2 -- a sweep of `mapped` over representative boundary values of EVERY MappedWorkSummary field,
  // including headingCount, which classifyMappedWork does not read today. The values span the
  // boundaries the current thresholds turn on (0; one; a count that crosses the 10% unknown / 25%
  // low-confidence ceilings against the swept block counts) plus a 0/positive split for the fields the
  // rubric does not read yet. Sweeping the INPUT space (the Cartesian product below) instead of
  // hand-picking outputs is what makes this pin robust to future edits: a newly added mapped sub-branch
  // keyed on an existing field -- e.g. a `headingCount === 0` rule producing a new reason -- is
  // exercised automatically, so that reason lands in producibleReasons and the direction-A test below
  // catches it if USABILITY_REASONS was not updated to match.
  const mappedSweep: MappedWorkSummary[] = [];
  for (const blockCount of [1, 10]) {
    for (const headingCount of [0, 1, 3]) {
      for (const unknownBlockCount of [0, 1, 2]) {
        for (const lowConfidenceBlockCount of [0, 1, 3]) {
          for (const unresolvedFigureCount of [0, 2]) {
            for (const plainTextLength of [0, 500]) {
              mappedSweep.push({
                blockCount,
                headingCount,
                lowConfidenceBlockCount,
                plainTextLength,
                unknownBlockCount,
                unresolvedFigureCount
              });
            }
          }
        }
      }
    }
  }

  const producibleReasons = new Set<PdfUsabilityReason>();
  for (const observation of nonMappedObservations) {
    producibleReasons.add(classifyPdfUsability(observation).reason);
  }
  for (const summary of mappedSweep) {
    producibleReasons.add(classifyPdfUsability({ kind: "mapped", summary }).reason);
  }

  // The reasons the committed report actually pre-seeds: summarizeCorpus([]) returns
  // reasonCounts = zeroed(USABILITY_REASONS), so its keys ARE USABILITY_REASONS — read through the
  // report (the thing that under-counts on drift), which keeps the list encapsulated in the module.
  const registeredReasons = new Set(
    Object.keys(summarizeCorpus([]).reasonCounts) as PdfUsabilityReason[]
  );

  // Residual gap, stated precisely so no one over-trusts this pin. The sweep varies EVERY current
  // MappedWorkSummary field, so the exact shape #842 was reopened for -- a new `mapped` sub-branch
  // keyed on an existing field, including headingCount which the rubric ignores today -- IS caught: the
  // reason it produces lands in producibleReasons and direction-A below goes red if it is unregistered.
  // NOT caught automatically, and each requires a visible production change that lands the developer
  // here: (1) a brand-new observation *kind* -- classifyPdfUsability's switch is exhaustive, so adding a
  // kind is a compile-forced production edit, but this pin only sees it once the kind is added to
  // nonMappedObservations above; (2) a brand-new MappedWorkSummary *field* with a branch keyed on it --
  // the sweep cannot vary a field that does not exist yet, so the loop must be extended when the field
  // and its rule are added; (3) a reason produced ONLY at a field value outside the representative
  // boundary set below -- mitigated by picking values on each active threshold, not exhaustive over all
  // integers. This is strictly narrower than the hand-picked table it replaced, which missed ANY new
  // sub-branch, not just these three.
  it("registers every reason the mapping can produce, so the corpus report can never silently drop one", () => {
    const producedButUnregistered = [...producibleReasons]
      .filter((reason) => !registeredReasons.has(reason))
      .sort();
    expect(
      producedButUnregistered,
      `The canonical mapping can return ${JSON.stringify(producedButUnregistered)}, but ` +
        `USABILITY_REASONS does not list that reason. summarizeCorpus seeds reasonCounts from ` +
        `USABILITY_REASONS, so an unregistered reason with a zero count is dropped from the corpus ` +
        `report and the run silently under-reports it (#832/#839). Add it to USABILITY_REASONS in ` +
        `pdfUsability.ts.`
    ).toEqual([]);
  });

  it("registers no reason the mapping can never produce, so the report carries no permanent phantom 0", () => {
    const registeredButUnproducible = [...registeredReasons]
      .filter((reason) => !producibleReasons.has(reason))
      .sort();
    expect(
      registeredButUnproducible,
      `USABILITY_REASONS lists ${JSON.stringify(registeredButUnproducible)}, but the canonical mapping ` +
        `never returns that reason across the non-mapped kinds or the MappedWorkSummary sweep above, ` +
        `so the corpus report would carry a row no case can ever fill. Either it is a stale entry ` +
        `(remove it from USABILITY_REASONS), or the sweep above no longer reaches it (widen the ` +
        `boundary values it varies).`
    ).toEqual([]);
  });
});
