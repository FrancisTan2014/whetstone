import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWorkContent, fetchWorks } from "./readerApi";

function stubFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    json: async () => response.body,
    ok: response.ok,
    status: response.status ?? 200
  }));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readerApi", () => {
  it("fetches works from the works endpoint", async () => {
    const fetchMock = stubFetch({ body: { works: [] }, ok: true });

    await expect(fetchWorks()).resolves.toEqual({ works: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/works", undefined);
  });

  it("fetches a work's content from its content endpoint", async () => {
    const content = { readingUnits: [], workEntryId: "work 1" };
    const fetchMock = stubFetch({ body: content, ok: true });

    await expect(fetchWorkContent("work 1")).resolves.toEqual(content);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/content", undefined);
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 503 });

    await expect(fetchWorks()).rejects.toThrow("failed with status 503");
  });
});
