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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contentApi", () => {
  it("fetches works from the works endpoint", async () => {
    const fetchMock = stubFetch({ body: { works: [] }, ok: true });

    await expect(fetchWorks()).resolves.toEqual({ works: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/works", undefined);
  });

  it("fetches a work's content from its content endpoint", async () => {
    const fetchMock = stubFetch({ body: { readingUnits: [], workEntryId: "work 1" }, ok: true });

    await expect(fetchWorkContent("work 1")).resolves.toEqual({
      readingUnits: [],
      workEntryId: "work 1"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/content", undefined);
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
