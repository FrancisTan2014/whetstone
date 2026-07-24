import { describe, expect, it } from "vitest";

import {
  concatenateRanges,
  flattenDocItems,
  isSupportedDoclingSchemaVersion,
  parseProbeClassification,
  parseRangeConversion,
  PINNED_DOCLING_CORE_VERSION,
  PINNED_DOCLING_VERSION,
  PINNED_OCRMYPDF_VERSION,
  PINNED_TESSERACT_VERSION,
  RANGE_CONVERSION_SCHEMA_VERSION,
  STRUCTURED_DOCUMENT_SCHEMA_VERSION,
  SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS,
  validateStructuredDocument,
  type RangeConversion,
  type StructuredDocItem
} from "./pdfStructuredContracts.js";

const supportedVersion = SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS[0]!;

function item(overrides: Partial<StructuredDocItem> = {}): StructuredDocItem {
  return {
    label: "text",
    pageNumber: 1,
    boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
    charSpan: [0, 3],
    confidence: 1,
    text: "hi",
    children: [],
    ...overrides
  };
}

function rangePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema: { name: "DoclingDocument", version: supportedVersion },
    pages: [{ pageNumber: 1, hasNativeText: true }],
    body: [item()],
    furniture: [],
    ...overrides
  });
}

describe("schema version support", () => {
  it("pins docling-core 2.87.1 (schema 1.10.0) as the supported runtime", () => {
    expect(PINNED_DOCLING_VERSION).toBe("2.114.0");
    expect(PINNED_DOCLING_CORE_VERSION).toBe("2.87.1");
    expect(SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS).toContain("1.10.0");
  });

  it("accepts a pinned version and rejects an unpinned one", () => {
    expect(isSupportedDoclingSchemaVersion(supportedVersion)).toBe(true);
    expect(isSupportedDoclingSchemaVersion("0.0.1")).toBe(false);
  });
});

describe("parseRangeConversion", () => {
  it("accepts a well-formed, pinned-schema payload and preserves its items", () => {
    const result = parseRangeConversion(rangePayload());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.schemaVersion).toBe(RANGE_CONVERSION_SCHEMA_VERSION);
    expect(result.value.body).toHaveLength(1);
  });

  it("reports invalid JSON as malformed with the parser's message", () => {
    const result = parseRangeConversion("{not json");
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") throw new Error("expected malformed");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("reports an unsupported docling schema version distinctly, before shape validation", () => {
    // Even with an otherwise-broken body, an unknown schema version is surfaced as unsupported so the
    // caller points at setup rather than blaming the file.
    const raw = JSON.stringify({
      schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
      doclingSchema: { name: "DoclingDocument", version: "3.0.0" },
      pages: "not-an-array",
      body: [],
      furniture: []
    });
    const result = parseRangeConversion(raw);
    expect(result).toEqual({ status: "unsupported_schema", version: "3.0.0" });
  });

  it("reports a supported-version payload with a bad shape as malformed", () => {
    const result = parseRangeConversion(rangePayload({ body: [{ label: "" }] }));
    expect(result.status).toBe("malformed");
  });

  it("treats a non-object JSON value as version-less and validates its shape", () => {
    expect(parseRangeConversion("123").status).toBe("malformed");
  });

  it("treats a non-object doclingSchema as version-less", () => {
    const result = parseRangeConversion(rangePayload({ doclingSchema: "oops" }));
    expect(result.status).toBe("malformed");
  });

  it("treats a non-string schema version as version-less", () => {
    const result = parseRangeConversion(
      rangePayload({ doclingSchema: { name: "DoclingDocument", version: 5 } })
    );
    expect(result.status).toBe("malformed");
  });

  it("rejects a charSpan whose start exceeds its end", () => {
    const result = parseRangeConversion(rangePayload({ body: [item({ charSpan: [5, 2] })] }));
    expect(result.status).toBe("malformed");
  });

  it("accepts a payload carrying cleaned document metadata", () => {
    const result = parseRangeConversion(
      rangePayload({ metadata: { title: "A Title", author: null } })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.metadata).toEqual({ title: "A Title", author: null });
  });

  it("rejects metadata carrying an unknown key", () => {
    const result = parseRangeConversion(
      rangePayload({ metadata: { title: "A Title", author: null, subject: "x" } })
    );
    expect(result.status).toBe("malformed");
  });

  it("rejects metadata missing a required field", () => {
    const result = parseRangeConversion(rangePayload({ metadata: { title: "A Title" } }));
    expect(result.status).toBe("malformed");
  });
});

describe("parseProbeClassification", () => {
  const page = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    pageNumber: 1,
    width: 612,
    height: 792,
    rotation: 0,
    hasNativeText: true,
    ...overrides
  });

  it("accepts a page count with matching per-page geometry/rotation/native-text", () => {
    const raw = JSON.stringify({
      pageCount: 2,
      pages: [
        page({ pageNumber: 1, hasNativeText: true, rotation: 90 }),
        page({ pageNumber: 2, hasNativeText: false, width: 100.5, height: 200.25 })
      ]
    });
    expect(parseProbeClassification(raw)).toEqual({
      status: "ok",
      pageCount: 2,
      pages: [
        { pageNumber: 1, width: 612, height: 792, rotation: 90, hasNativeText: true },
        { pageNumber: 2, width: 100.5, height: 200.25, rotation: 0, hasNativeText: false }
      ]
    });
  });

  it("accepts an empty document (zero pages)", () => {
    expect(parseProbeClassification(JSON.stringify({ pageCount: 0, pages: [] }))).toEqual({
      status: "ok",
      pageCount: 0,
      pages: []
    });
  });

  it("reports invalid JSON as malformed", () => {
    expect(parseProbeClassification("nope").status).toBe("malformed");
  });

  it("rejects a missing, non-integer, or negative page count", () => {
    expect(parseProbeClassification(JSON.stringify({ pages: [] })).status).toBe("malformed");
    expect(
      parseProbeClassification(JSON.stringify({ pageCount: 1.5, pages: [page()] })).status
    ).toBe("malformed");
    expect(parseProbeClassification(JSON.stringify({ pageCount: -1, pages: [] })).status).toBe(
      "malformed"
    );
    expect(parseProbeClassification("null").status).toBe("malformed");
  });

  it("rejects a page-count/records length mismatch", () => {
    expect(parseProbeClassification(JSON.stringify({ pageCount: 2, pages: [page()] })).status).toBe(
      "malformed"
    );
  });

  it("rejects a duplicate or out-of-range page number", () => {
    expect(
      parseProbeClassification(
        JSON.stringify({ pageCount: 2, pages: [page({ pageNumber: 1 }), page({ pageNumber: 1 })] })
      ).status
    ).toBe("malformed");
    expect(
      parseProbeClassification(JSON.stringify({ pageCount: 1, pages: [page({ pageNumber: 5 })] }))
        .status
    ).toBe("malformed");
  });

  it("rejects a negative dimension or an unsupported rotation", () => {
    expect(
      parseProbeClassification(JSON.stringify({ pageCount: 1, pages: [page({ width: -1 })] }))
        .status
    ).toBe("malformed");
    expect(
      parseProbeClassification(JSON.stringify({ pageCount: 1, pages: [page({ rotation: 45 })] }))
        .status
    ).toBe("malformed");
  });

  it("rejects a page record carrying an unknown key", () => {
    expect(
      parseProbeClassification(JSON.stringify({ pageCount: 1, pages: [page({ dpi: 300 })] })).status
    ).toBe("malformed");
  });
});

describe("pinned OCR toolchain versions", () => {
  it("pins the exact OCRmyPDF and Tesseract versions the fingerprint records", () => {
    expect(PINNED_OCRMYPDF_VERSION).toBe("16.10.4");
    expect(PINNED_TESSERACT_VERSION).toBe("5.5.1");
  });
});

describe("validateStructuredDocument", () => {
  const document = {
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    doclingSchema: { name: "DoclingDocument", version: supportedVersion },
    source: { sha256: "a".repeat(64), byteLength: 10, pageCount: 1 },
    pages: [{ pageNumber: 1, hasNativeText: true }],
    body: [item()],
    furniture: []
  };

  it("accepts a well-formed structured document", () => {
    const result = validateStructuredDocument(document);
    expect(result.ok).toBe(true);
  });

  it("rejects a bad sha256 with a message", () => {
    const result = validateStructuredDocument({
      ...document,
      source: { ...document.source, sha256: "xyz" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.detail.length).toBeGreaterThan(0);
  });
});

describe("concatenateRanges", () => {
  const source = { sha256: "b".repeat(64), byteLength: 20, pageCount: 3 };

  function range(pages: number[]): RangeConversion {
    return {
      schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
      doclingSchema: { name: "DoclingDocument", version: supportedVersion },
      pages: pages.map((pageNumber) => ({ pageNumber, hasNativeText: true })),
      body: pages.map((pageNumber) => item({ pageNumber, text: `p${pageNumber}` })),
      furniture: []
    };
  }

  it("keeps body items in source order and sorts pages by number", () => {
    const document = concatenateRanges(source, [range([2, 1]), range([3])]);
    expect(document.body.map((entry) => entry.text)).toEqual(["p2", "p1", "p3"]);
    expect(document.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(document.source).toEqual(source);
    expect(document.doclingSchema.version).toBe(supportedVersion);
  });

  it("falls back to the pinned docling schema when there are no ranges", () => {
    const document = concatenateRanges({ ...source, pageCount: 0 }, []);
    expect(document.doclingSchema).toEqual({ name: "DoclingDocument", version: supportedVersion });
    expect(document.body).toEqual([]);
  });

  it("omits document metadata when no range carried any", () => {
    const document = concatenateRanges(source, [range([1])]);
    expect(document.metadata).toBeUndefined();
  });

  it("surfaces the first non-null title and author seen across ranges", () => {
    const document = concatenateRanges(source, [
      { ...range([1]), metadata: { title: null, author: "Ada Lovelace" } },
      { ...range([2]), metadata: { title: "Notes on the Engine", author: "Ignored" } }
    ]);
    expect(document.metadata).toEqual({ title: "Notes on the Engine", author: "Ada Lovelace" });
  });

  it("keeps a partial metadata field null when no range supplies it", () => {
    const document = concatenateRanges(source, [
      { ...range([1]), metadata: { title: "Only A Title", author: null } }
    ]);
    expect(document.metadata).toEqual({ title: "Only A Title", author: null });
  });
});

describe("flattenDocItems", () => {
  it("flattens a tree depth-first, parents before children, preserving low-confidence items", () => {
    const tree = [
      item({ text: "parent", confidence: 0.1, children: [item({ text: "child" })] }),
      item({ text: "sibling" })
    ];
    expect(flattenDocItems(tree).map((entry) => entry.text)).toEqual([
      "parent",
      "child",
      "sibling"
    ]);
  });
});
