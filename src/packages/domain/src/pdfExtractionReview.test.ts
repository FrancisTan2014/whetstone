import { describe, expect, it } from "vitest";

import {
  classifyExtractionConfidence,
  isUnmappedBlockType,
  PDF_EXTRACTION_CONFIDENCE_THRESHOLD,
  suggestsExtractionReview,
  UNMAPPED_BLOCK_TYPE
} from "./pdfExtractionReview.js";

describe("classifyExtractionConfidence", () => {
  it("bands a null confidence as not reported", () => {
    expect(classifyExtractionConfidence(null)).toBe("not-reported");
  });

  it("bands a confidence at the threshold as high (inclusive boundary)", () => {
    expect(classifyExtractionConfidence(PDF_EXTRACTION_CONFIDENCE_THRESHOLD)).toBe("high");
  });

  it("bands a confidence above the threshold as high", () => {
    expect(classifyExtractionConfidence(0.99)).toBe("high");
  });

  it("bands a confidence just below the threshold as review-suggested", () => {
    expect(classifyExtractionConfidence(PDF_EXTRACTION_CONFIDENCE_THRESHOLD - 0.0001)).toBe(
      "review-suggested"
    );
  });

  it("bands a zero confidence as review-suggested, distinct from a missing one", () => {
    expect(classifyExtractionConfidence(0)).toBe("review-suggested");
  });
});

describe("isUnmappedBlockType", () => {
  it("is true only for the mapper's unknown/fallback node type", () => {
    expect(isUnmappedBlockType(UNMAPPED_BLOCK_TYPE)).toBe(true);
  });

  it("is false for a mapped canonical node type", () => {
    expect(isUnmappedBlockType("paragraph")).toBe(false);
    expect(isUnmappedBlockType("heading")).toBe(false);
    expect(isUnmappedBlockType("table")).toBe(false);
  });
});

describe("suggestsExtractionReview", () => {
  it("suggests review for a below-threshold confidence even when the label mapped", () => {
    expect(suggestsExtractionReview({ confidence: 0.5, unmapped: false })).toBe(true);
  });

  it("suggests review for an unmapped block even at high confidence", () => {
    expect(suggestsExtractionReview({ confidence: 0.99, unmapped: true })).toBe(true);
  });

  it("suggests review for an unmapped block whose confidence was never reported", () => {
    expect(suggestsExtractionReview({ confidence: null, unmapped: true })).toBe(true);
  });

  it("does not suggest review for a high-confidence mapped block", () => {
    expect(suggestsExtractionReview({ confidence: 0.9, unmapped: false })).toBe(false);
  });

  it("does not suggest review for a null-confidence mapped block (missing is not below threshold)", () => {
    expect(suggestsExtractionReview({ confidence: null, unmapped: false })).toBe(false);
  });

  it("does not suggest review for a mapped block exactly at the threshold", () => {
    expect(
      suggestsExtractionReview({ confidence: PDF_EXTRACTION_CONFIDENCE_THRESHOLD, unmapped: false })
    ).toBe(false);
  });
});
