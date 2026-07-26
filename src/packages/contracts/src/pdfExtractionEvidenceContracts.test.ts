import { describe, expect, it } from "vitest";

import { parsePdfExtractionEvidenceDto } from "./pdfExtractionEvidenceContracts.js";

// #763 boundary validation for the read-only extraction-evidence response. The parser is the single trust
// boundary before the client decorates blocks with it, so these prove it accepts the well-formed shape
// (including a null confidence and absent OCR provenance) and rejects malformed or extra-field payloads.

const item = {
  blockId: "block-1",
  confidence: 0.42,
  corrected: false,
  label: "text",
  ocrEngine: "tesseract-5",
  ocrLanguage: "eng",
  page: 3,
  reviewSuggested: true
};

describe("parsePdfExtractionEvidenceDto", () => {
  it("accepts a well-formed evidence list", () => {
    const parsed = parsePdfExtractionEvidenceDto({ items: [item] });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.blockId).toBe("block-1");
    expect(parsed.items[0]?.reviewSuggested).toBe(true);
  });

  it("accepts an empty list (a non-PDF imported Work carries no evidence)", () => {
    expect(parsePdfExtractionEvidenceDto({ items: [] }).items).toEqual([]);
  });

  it("accepts a null confidence and absent OCR provenance", () => {
    const parsed = parsePdfExtractionEvidenceDto({
      items: [{ ...item, confidence: null, ocrEngine: null, ocrLanguage: null }]
    });
    expect(parsed.items[0]?.confidence).toBeNull();
    expect(parsed.items[0]?.ocrEngine).toBeNull();
  });

  it("rejects a non-integer page", () => {
    expect(() => parsePdfExtractionEvidenceDto({ items: [{ ...item, page: 1.5 }] })).toThrow();
  });

  it("rejects an unexpected extra field", () => {
    expect(() =>
      parsePdfExtractionEvidenceDto({ items: [{ ...item, filePath: "/etc/passwd" }] })
    ).toThrow();
  });

  it("rejects a missing items field", () => {
    expect(() => parsePdfExtractionEvidenceDto({})).toThrow();
  });
});
