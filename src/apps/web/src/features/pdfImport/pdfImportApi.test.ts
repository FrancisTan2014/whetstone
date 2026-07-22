import type { PdfImportViewDto } from "@whetstone/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginPdfImport,
  cancelPdfImport,
  fetchPdfImportView,
  retryPdfImport
} from "./pdfImportApi";

const sha = "c".repeat(64);

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

// jsdom's File lacks arrayBuffer() here; supply the bytes the api will POST plus a name for provenance.
function pdfFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return {
    arrayBuffer: async () => bytes.buffer,
    name,
    type: "application/pdf"
  } as unknown as File;
}

function statusDto(): PdfImportViewDto["status"] {
  return {
    adapterFingerprint: null,
    attemptId: "attempt-1",
    completedPages: 0,
    completedRanges: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    failure: null,
    heartbeatAt: null,
    sourceHash: sha,
    stage: { bound: true },
    state: "queued",
    totalPages: null,
    totalRanges: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function view(): PdfImportViewDto {
  return { publication: { status: "pending" }, status: statusDto() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("beginPdfImport", () => {
  it("streams the bytes with base64-encoded metadata and returns a queued attempt", async () => {
    const fetchMock = stubFetch({
      body: { attemptId: "attempt-1", outcome: "queued", status: statusDto() },
      ok: true,
      status: 201
    });
    const bytes = new Uint8Array([1, 2, 3]);

    const result = await beginPdfImport(pdfFile(bytes, "My Book.pdf"), {
      enteredAuthor: "Ada Lovelace",
      enteredLanguage: "en",
      enteredTitle: "My Book",
      fileName: "My Book.pdf"
    });

    expect(result).toEqual({ attemptId: "attempt-1", outcome: "queued", status: statusDto() });
    const [path, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> }
    ];
    expect(path).toBe("/api/pdf-imports");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(bytes.buffer);
    expect(init.headers["content-type"]).toBe("application/pdf");
    // The metadata header is base64 of the UTF-8 JSON, so it decodes back to the sent intent.
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(init.headers["x-pdf-import-metadata"] ?? ""), (c) => c.charCodeAt(0))
      )
    );
    expect(decoded).toEqual({
      enteredAuthor: "Ada Lovelace",
      enteredLanguage: "en",
      enteredTitle: "My Book",
      fileName: "My Book.pdf"
    });
  });

  it("returns a reopened Work when identical bytes already own one", async () => {
    stubFetch({ body: { outcome: "reopened", workEntryId: "work-9" }, ok: true, status: 200 });

    const result = await beginPdfImport(pdfFile(new Uint8Array([1])), { fileName: "doc.pdf" });

    expect(result).toEqual({ outcome: "reopened", workEntryId: "work-9" });
  });

  it("throws when the server rejects the upload", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(
      beginPdfImport(pdfFile(new Uint8Array([1])), { fileName: "doc.pdf" })
    ).rejects.toThrow("failed with status 400");
  });
});

describe("fetchPdfImportView", () => {
  it("returns the parsed view on success", async () => {
    stubFetch({ body: view(), ok: true, status: 200 });

    await expect(fetchPdfImportView("attempt-1")).resolves.toEqual(view());
  });

  it("returns null when the attempt no longer exists (404)", async () => {
    const fetchMock = stubFetch({ ok: false, status: 404 });

    await expect(fetchPdfImportView("gone/id")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/pdf-imports/gone%2Fid");
  });

  it("throws on another non-ok status", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchPdfImportView("attempt-1")).rejects.toThrow("failed with status 500");
  });
});

describe("cancelPdfImport / retryPdfImport", () => {
  it("cancels and returns the updated view", async () => {
    const fetchMock = stubFetch({ body: view(), ok: true, status: 200 });

    await expect(cancelPdfImport("attempt-1")).resolves.toEqual(view());
    expect(fetchMock).toHaveBeenCalledWith("/api/pdf-imports/attempt-1/cancel", { method: "POST" });
  });

  it("retries and returns the updated view", async () => {
    const fetchMock = stubFetch({ body: view(), ok: true, status: 200 });

    await expect(retryPdfImport("attempt-1")).resolves.toEqual(view());
    expect(fetchMock).toHaveBeenCalledWith("/api/pdf-imports/attempt-1/retry", { method: "POST" });
  });

  it("returns null when the attempt is gone", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(cancelPdfImport("attempt-1")).resolves.toBeNull();
  });

  it("throws on another non-ok status", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(retryPdfImport("attempt-1")).rejects.toThrow("failed with status 500");
  });
});
