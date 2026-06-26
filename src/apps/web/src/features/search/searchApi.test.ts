// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchLibrary } from "./searchApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("searchLibrary", () => {
  it("requests the search endpoint with the encoded query and validates the response", async () => {
    const body = {
      query: "a dog",
      results: [
        {
          authorName: "George Orwell",
          blockEntryId: "block-1",
          plaintext: "The dog barked.",
          workEntryId: "work-1",
          workTitle: "Animal Farm"
        }
      ]
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(body),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchLibrary("a dog");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/search?q=a%20dog");
  });

  it("parses an empty result set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ query: "absent", results: [] }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchLibrary("absent")).toEqual({ query: "absent", results: [] });
  });

  it("throws when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
      ok: false,
      status: 500
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchLibrary("dog")).rejects.toThrow("status 500");
  });
});
