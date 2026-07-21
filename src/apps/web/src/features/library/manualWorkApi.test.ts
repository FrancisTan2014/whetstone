import { createTextDocument } from "@whetstone/document";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchManualWork, saveManualWorkContent } from "./manualWorkApi";

const document = createTextDocument("A curated passage.");

const dto = {
  createdAt: "2026-07-01T10:00:00.000Z",
  document,
  entryId: "work-1",
  language: "en" as const,
  revision: "2026-07-01T11:00:00.000Z",
  title: "Reading notes",
  unitEntryId: "unit-1",
  updatedAt: "2026-07-01T11:00:00.000Z",
  workType: "book" as const
};

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

describe("fetchManualWork", () => {
  it("parses the loaded manual work at the boundary", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(fetchManualWork("work-1")).resolves.toEqual(dto);
    expect(fetchMock).toHaveBeenCalledWith("/api/manual-works/work-1");
  });

  it("throws when the load fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchManualWork("work-1")).rejects.toThrow(/status 404/);
  });
});

describe("saveManualWorkContent", () => {
  it("returns the reopened work on success", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(saveManualWorkContent("work-1", document, dto.revision)).resolves.toEqual({
      status: "saved",
      work: dto
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manual-works/work-1/content",
      expect.objectContaining({ method: "PUT" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ document, revision: dto.revision });
  });

  it("reports a stale revision as a conflict", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(saveManualWorkContent("work-1", document, "old")).resolves.toEqual({
      status: "conflict"
    });
  });

  it("reports a rejected document as invalid", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(saveManualWorkContent("work-1", document, "r")).resolves.toEqual({
      status: "invalid"
    });
  });

  it("throws on an unexpected non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(saveManualWorkContent("work-1", document, "r")).rejects.toThrow(/status 500/);
  });
});
