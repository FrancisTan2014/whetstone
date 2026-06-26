import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWorkContent, fetchWorks, ingestMarkdown } from "./contentApi";

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

// Routes each request URL to a prepared JSON body so the composed content fetch (structure +
// per-unit content) can be asserted end to end.
function stubFetchByUrl(bodies: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (path: string) => ({
    ok: true,
    status: 200,
    json: async () => bodies[path]
  }));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contentApi", () => {
  it("fetches works from the works endpoint", async () => {
    const fetchMock = stubFetch({ body: { works: [] }, ok: true });

    await expect(fetchWorks()).resolves.toEqual({ works: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/works", undefined);
  });

  it("assembles a work's content from its structure and each unit's content", async () => {
    const unitOne = {
      blocks: [
        { blockType: "paragraph", entryId: "b-1", mdast: {}, orderIndex: 0, plaintext: "A" }
      ],
      entryId: "u-1",
      orderIndex: 0,
      title: "One"
    };
    const unitTwo = {
      blocks: [
        { blockType: "paragraph", entryId: "b-2", mdast: {}, orderIndex: 0, plaintext: "B" }
      ],
      entryId: "u-2",
      orderIndex: 1
    };
    const fetchMock = stubFetchByUrl({
      "/api/works/work%201/structure": {
        readingUnits: [
          { blockCount: 1, entryId: "u-1", orderIndex: 0, title: "One" },
          { blockCount: 1, entryId: "u-2", orderIndex: 1 }
        ],
        workEntryId: "work 1"
      },
      "/api/works/work%201/units/u-1/content": unitOne,
      "/api/works/work%201/units/u-2/content": unitTwo
    });

    await expect(fetchWorkContent("work 1")).resolves.toEqual({
      readingUnits: [unitOne, unitTwo],
      workEntryId: "work 1"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/structure", undefined);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/units/u-1/content", undefined);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/units/u-2/content", undefined);
  });

  it("returns empty content for a work with no reading units", async () => {
    stubFetchByUrl({
      "/api/works/work-1/structure": { readingUnits: [], workEntryId: "work-1" }
    });

    await expect(fetchWorkContent("work-1")).resolves.toEqual({
      readingUnits: [],
      workEntryId: "work-1"
    });
  });

  it("posts a Markdown source and returns the updated content", async () => {
    const content = { readingUnits: [], workEntryId: "work-1" };
    const fetchMock = stubFetch({ body: content, ok: true });

    await expect(
      ingestMarkdown("work-1", { kind: "manual", markdown: "# Title" })
    ).resolves.toEqual(content);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work-1/content", {
      body: JSON.stringify({ kind: "manual", markdown: "# Title" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchWorkContent("missing")).rejects.toThrow("failed with status 404");
  });
});
