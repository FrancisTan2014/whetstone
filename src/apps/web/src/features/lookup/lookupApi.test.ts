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
      entry: {
        headword: "set",
        partsOfSpeech: [{ senses: [{ definition: "a group", examples: [], synonyms: [] }] }],
        pronunciations: [{ ipa: "/sɛt/" }],
        sources: ["From a source."]
      },
      found: true
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(body),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupTerm("a set", "en", "wordnet");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/lookup?term=a%20set&language=en&source=wordnet");
  });

  it("parses an explicit not-found response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ found: false }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupTerm("absent", "en", "wiktionary")).toEqual({ found: false });
  });

  it("appends the truncated context only when provided, for the local-LLM source (#341)", async () => {
    const body = { found: false };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(body),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    // A short context is sent as-is, URL-encoded.
    await lookupTerm("六艺", "zh-CN", "llm", "六艺者，礼、乐、射、御、书、数也。");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/lookup?term=${encodeURIComponent("六艺")}&language=zh-CN&source=llm&context=${encodeURIComponent("六艺者，礼、乐、射、御、书、数也。")}`
    );

    // A very long context is truncated to a sane bound before it reaches the query string.
    const longContext = "字".repeat(2000);
    await lookupTerm("六艺", "zh-CN", "llm", longContext);
    const lastUrl = fetchMock.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain(`context=${encodeURIComponent("字".repeat(1000))}`);
    expect(lastUrl).not.toContain(encodeURIComponent("字".repeat(1001)));
  });

  it("throws when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
      ok: false,
      status: 500
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupTerm("word", "en", "wordnet")).rejects.toThrow("status 500");
  });
});
