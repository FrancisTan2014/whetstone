import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchUnitContent, fetchWorks, fetchWorkStructure, locateBlockUnit } from "./readerApi";

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

  it("fetches a work's structure from its structure endpoint", async () => {
    const structure = { readingUnits: [], workEntryId: "work 1" };
    const fetchMock = stubFetch({ body: structure, ok: true });

    await expect(fetchWorkStructure("work 1")).resolves.toEqual(structure);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/structure", undefined);
  });

  it("fetches a reading unit's content from its unit-content endpoint", async () => {
    const content = { blocks: [], entryId: "unit 2", orderIndex: 0 };
    const fetchMock = stubFetch({ body: content, ok: true });

    await expect(fetchUnitContent("work 1", "unit 2")).resolves.toEqual(content);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/units/unit%202/content", undefined);
  });

  it("resolves a block to its owning unit via the locator endpoint", async () => {
    const fetchMock = stubFetch({ body: { unitEntryId: "u-2" }, ok: true, status: 200 });

    await expect(locateBlockUnit("work 1", "b 3")).resolves.toBe("u-2");
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/blocks/b%203/unit");
  });

  it("resolves to undefined when the locator returns 404", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(locateBlockUnit("work 1", "b-missing")).resolves.toBeUndefined();
  });

  it("throws when the locator responds with another non-ok status", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(locateBlockUnit("work 1", "b 3")).rejects.toThrow("failed with status 500");
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 503 });

    await expect(fetchWorks()).rejects.toThrow("failed with status 503");
  });
});
