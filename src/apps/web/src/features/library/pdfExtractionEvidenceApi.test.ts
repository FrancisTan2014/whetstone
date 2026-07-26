import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPdfExtractionEvidence } from "./pdfExtractionEvidenceApi";

// One evidence item as the server returns it: the SAFE per-block projection the client keys by block id.
function item(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    blockId: "block-1",
    confidence: 0.4,
    corrected: false,
    label: "text",
    ocrEngine: null,
    ocrLanguage: null,
    page: 1,
    reviewSuggested: true,
    ...overrides
  };
}

function stubFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body
  }));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPdfExtractionEvidence", () => {
  it("parses the evidence and returns it keyed by block id", async () => {
    const fetchMock = stubFetch({
      ok: true,
      body: { items: [item(), item({ blockId: "block-2", corrected: true, page: 2 })] }
    });

    const evidence = await fetchPdfExtractionEvidence("work-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/imported-works/work-1/extraction-evidence");
    expect([...evidence.keys()]).toEqual(["block-1", "block-2"]);
    expect(evidence.get("block-2")).toMatchObject({ corrected: true, page: 2 });
  });

  it("returns an empty map for a Work the endpoint declines (404)", async () => {
    stubFetch({ ok: false, status: 404 });

    const evidence = await fetchPdfExtractionEvidence("work-1");

    expect(evidence.size).toBe(0);
  });

  it("returns an empty map for a Work with no evidence", async () => {
    stubFetch({ ok: true, body: { items: [] } });

    const evidence = await fetchPdfExtractionEvidence("work-1");

    expect(evidence.size).toBe(0);
  });

  it("encodes the work id in the request path", async () => {
    const fetchMock = stubFetch({ ok: true, body: { items: [] } });

    await fetchPdfExtractionEvidence("work/1 a");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/imported-works/work%2F1%20a/extraction-evidence"
    );
  });

  it("throws on an unexpected non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchPdfExtractionEvidence("work-1")).rejects.toThrow(/status 500/);
  });
});
