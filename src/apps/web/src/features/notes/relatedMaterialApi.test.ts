import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RelatedMaterialRelationsResponse,
  RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { fetchRelatedRelations, fetchRelatedSenses } from "./relatedMaterialApi";

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }): ReturnType<
  typeof vi.fn
> {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetchThrows(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    throw new Error("network down");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answerDoc = createTextDocument("born");

describe("fetchRelatedSenses", () => {
  it("posts only the Answer document to the senses route and returns the parsed found outcome", async () => {
    const body: RelatedMaterialSensesResponse = {
      status: "found",
      surface: "born",
      senses: [
        {
          offset: "02636952",
          partOfSpeech: "verb",
          definition: "give birth",
          examples: ["she bore a son"],
          lemmas: ["bear", "have"]
        }
      ]
    };
    const fetchMock = stubFetch({ ok: true, body });

    const result = await fetchRelatedSenses(answerDoc);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/related-material/senses", {
      body: JSON.stringify({ answerDoc }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("maps a non-2xx response to the retryable unavailable status", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "boom" } });

    expect(await fetchRelatedSenses(answerDoc)).toEqual({ status: "unavailable" });
  });

  it("maps a transport failure to the retryable unavailable status", async () => {
    stubFetchThrows();

    expect(await fetchRelatedSenses(answerDoc)).toEqual({ status: "unavailable" });
  });

  it("maps a drifted body that fails to parse to the retryable unavailable status", async () => {
    stubFetch({ ok: true, body: { status: "bogus" } });

    expect(await fetchRelatedSenses(answerDoc)).toEqual({ status: "unavailable" });
  });

  it("returns the silent not_found outcome verbatim", async () => {
    stubFetch({ ok: true, body: { status: "not_found" } });

    expect(await fetchRelatedSenses(answerDoc)).toEqual({ status: "not_found" });
  });
});

describe("fetchRelatedRelations", () => {
  const sense = { offset: "02636952", partOfSpeech: "verb" } as const;

  it("posts the Answer document and the selected sense and returns the parsed found outcome", async () => {
    const body: RelatedMaterialRelationsResponse = {
      status: "found",
      surface: "born",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [
        {
          relation: "inflection",
          direction: "lateral",
          notes: [{ noteId: "note-1", word: "bear", context: "a mother bears a child" }]
        }
      ]
    };
    const fetchMock = stubFetch({ ok: true, body });

    const result = await fetchRelatedRelations(answerDoc, sense);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/related-material/relations", {
      body: JSON.stringify({ answerDoc, sense }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("maps a non-2xx response to the retryable unavailable status", async () => {
    stubFetch({ ok: false, status: 503 });

    expect(await fetchRelatedRelations(answerDoc, sense)).toEqual({ status: "unavailable" });
  });

  it("maps a transport failure to the retryable unavailable status", async () => {
    stubFetchThrows();

    expect(await fetchRelatedRelations(answerDoc, sense)).toEqual({ status: "unavailable" });
  });

  it("returns the silent unsupported outcome verbatim", async () => {
    stubFetch({ ok: true, body: { status: "unsupported" } });

    expect(await fetchRelatedRelations(answerDoc, sense)).toEqual({ status: "unsupported" });
  });
});
