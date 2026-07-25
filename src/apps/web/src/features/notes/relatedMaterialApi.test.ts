import { createTextDocument } from "@whetstone/document";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRelatedRelations, fetchRelatedSenses } from "./relatedMaterialApi";

// The "Find related material" fetch boundary (#716): the API folds any transport failure or non-2xx status
// into the `unavailable` status the disclosure renders (with Retry), so it can never masquerade as "no
// related material" or block the save. A 2xx body is parsed through the shared contracts schema.

function stubFetch(response: { body?: unknown; ok: boolean; status?: number }): ReturnType<typeof vi.fn> {
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

const answerDoc = createTextDocument("bear");
const sense = { offset: "02expected", partOfSpeech: "verb" } as const;

describe("fetchRelatedSenses (#716)", () => {
  it("POSTs only the Answer document and returns the parsed found senses", async () => {
    const body = {
      status: "found",
      surface: "bear",
      senses: [
        {
          offset: "02expected",
          partOfSpeech: "verb",
          definition: "give birth to",
          examples: ["she bore a son"],
          lemmas: ["bear", "birth"]
        }
      ]
    };
    const fetchMock = stubFetch({ body, ok: true });

    await expect(fetchRelatedSenses(answerDoc)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/related-material/senses", {
      body: JSON.stringify({ answerDoc }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("passes through a non-found status", async () => {
    stubFetch({ body: { status: "not_found" }, ok: true });

    await expect(fetchRelatedSenses(answerDoc)).resolves.toEqual({ status: "not_found" });
  });

  it("folds a non-2xx response into unavailable so the disclosure offers Retry", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchRelatedSenses(answerDoc)).resolves.toEqual({ status: "unavailable" });
  });

  it("folds a rejected fetch into unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    await expect(fetchRelatedSenses(answerDoc)).resolves.toEqual({ status: "unavailable" });
  });
});

describe("fetchRelatedRelations (#716)", () => {
  it("POSTs the Answer and selected sense and returns the parsed found relations", async () => {
    const body = {
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [
        {
          relation: "inflection",
          direction: "lateral",
          notes: [{ noteId: "note-1", word: "born", context: "she was born" }]
        }
      ]
    };
    const fetchMock = stubFetch({ body, ok: true });

    await expect(fetchRelatedRelations(answerDoc, sense)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/related-material/relations", {
      body: JSON.stringify({ answerDoc, sense }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("folds a non-2xx response into unavailable", async () => {
    stubFetch({ ok: false, status: 503 });

    await expect(fetchRelatedRelations(answerDoc, sense)).resolves.toEqual({
      status: "unavailable"
    });
  });

  it("folds a rejected fetch into unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    await expect(fetchRelatedRelations(answerDoc, sense)).resolves.toEqual({
      status: "unavailable"
    });
  });
});
