// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupTerm } from "./lookupApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lookupTerm", () => {
  it("requests the lookup endpoint with the encoded term and validates the response", async () => {
    const body = {
      attribution: "Source.",
      entry: { headword: "set", senses: [{ gloss: "a group" }] },
      found: true
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(body),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupTerm("a set", "en");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/lookup?term=a%20set&language=en");
  });

  it("parses an explicit not-found response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ found: false }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupTerm("absent", "en")).toEqual({ found: false });
  });

  it("throws when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
      ok: false,
      status: 500
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupTerm("word", "en")).rejects.toThrow("status 500");
  });
});
