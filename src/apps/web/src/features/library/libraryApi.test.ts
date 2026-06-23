import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthor, createWork, fetchAuthors, fetchWorks } from "./libraryApi";

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

describe("libraryApi", () => {
  it("fetches authors from the authors endpoint", async () => {
    const fetchMock = stubFetch({ ok: true, body: { authors: [] } });

    await expect(fetchAuthors()).resolves.toEqual({ authors: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/authors", undefined);
  });

  it("fetches works from the works endpoint", async () => {
    const fetchMock = stubFetch({ ok: true, body: { works: [] } });

    await expect(fetchWorks()).resolves.toEqual({ works: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/works", undefined);
  });

  it("posts a new author and returns the created author", async () => {
    const fetchMock = stubFetch({ ok: true, body: { id: "author-1", name: "Ada Lovelace" } });

    await expect(createAuthor({ name: "Ada Lovelace" })).resolves.toEqual({
      id: "author-1",
      name: "Ada Lovelace"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/authors", {
      body: JSON.stringify({ name: "Ada Lovelace" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("posts a new work and returns the created work item", async () => {
    const work = {
      author: { id: "author-1", name: "Ada Lovelace" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "Notes",
        workType: "essay"
      }
    };
    const fetchMock = stubFetch({ ok: true, body: work });

    await expect(
      createWork({
        author: { mode: "new", name: "Ada Lovelace" },
        language: "en",
        title: "Notes",
        workType: "essay"
      })
    ).resolves.toEqual(work);
    expect(fetchMock).toHaveBeenCalledWith("/api/works", {
      body: JSON.stringify({
        author: { mode: "new", name: "Ada Lovelace" },
        language: "en",
        title: "Notes",
        workType: "essay"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 500, body: undefined });

    await expect(fetchAuthors()).rejects.toThrow("failed with status 500");
  });
});
