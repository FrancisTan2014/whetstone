import { describe, expect, it } from "vitest";

import {
  concatenateRanges,
  flattenDocItems,
  isSupportedDoclingSchemaVersion,
  parseProbePageCount,
  parseRangeConversion,
  PINNED_DOCLING_CORE_VERSION,
  PINNED_DOCLING_VERSION,
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
});

describe("parseProbePageCount", () => {
  it("accepts a non-negative integer page count", () => {
    expect(parseProbePageCount(JSON.stringify({ pageCount: 12 }))).toEqual({
      status: "ok",
      pageCount: 12
    });
  });

  it("reports invalid JSON as malformed", () => {
    expect(parseProbePageCount("nope").status).toBe("malformed");
  });

  it("rejects a missing, non-integer, or negative page count", () => {
    expect(parseProbePageCount(JSON.stringify({})).status).toBe("malformed");
    expect(parseProbePageCount(JSON.stringify({ pageCount: 1.5 })).status).toBe("malformed");
    expect(parseProbePageCount(JSON.stringify({ pageCount: -1 })).status).toBe("malformed");
    expect(parseProbePageCount("null").status).toBe("malformed");
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
