import { describe, expect, it } from "vitest";

import { adaptWiktionary, createFreeDictionaryProvider } from "./freeDictionaryProvider.js";
import {
  createHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpResult
} from "./httpClient.js";

const cannedEntry = {
  meanings: [
    {
      definitions: [
        {
          definition: "to put something in a specified place",
          example: "set it down",
          synonyms: ["place", "put"]
        },
        { definition: "to fix firmly" }
      ],
      partOfSpeech: "verb",
      synonyms: ["position"]
    },
    {
      definitions: [{ definition: "a group of similar things", example: "a chess set" }],
      partOfSpeech: "noun"
    }
  ],
  origin: "Old English settan.",
  phonetic: "/sɛt/",
  phonetics: [
    { audio: "https://audio.example/set.mp3", text: "/sɛt/" },
    { text: "/sɛt/" },
    { audio: "https://audio.example/dup.mp3" },
    { audio: "", text: "/set/" },
    "not-a-record"
  ],
  word: "set"
};

function fakeHttpClient(
  result: HttpResult<unknown>
): HttpClient & { lastUrl: () => string; lastTimeoutMs: () => number | undefined } {
  let requestedUrl = "";
  let requestedTimeoutMs: number | undefined;
  return {
    getJson: <T>(url: string, options?: { timeoutMs?: number }): Promise<HttpResult<T>> => {
      requestedUrl = url;
      requestedTimeoutMs = options?.timeoutMs;
      return Promise.resolve(result as HttpResult<T>);
    },
    getText: () => Promise.resolve({ error: { kind: "network" }, ok: false }),
    lastUrl: () => requestedUrl,
    lastTimeoutMs: () => requestedTimeoutMs
  };
}

describe("adaptWiktionary", () => {
  it("normalizes pronunciations, etymology, and senses with examples and unioned synonyms", () => {
    expect(adaptWiktionary([cannedEntry])).toEqual({
      etymology: "Old English settan.",
      partsOfSpeech: [
        {
          partOfSpeech: "verb",
          senses: [
            {
              definition: "to put something in a specified place",
              examples: ["set it down"],
              synonyms: ["place", "put", "position"]
            },
            { definition: "to fix firmly", examples: [], synonyms: ["position"] }
          ]
        },
        {
          partOfSpeech: "noun",
          senses: [
            { definition: "a group of similar things", examples: ["a chess set"], synonyms: [] }
          ]
        }
      ],
      pronunciations: [{ audio: "https://audio.example/set.mp3", ipa: "/sɛt/" }, { ipa: "/set/" }]
    });
  });

  it("excludes the headword and duplicate synonyms (case-insensitive), and skips non-string ones", () => {
    const entry = {
      meanings: [
        {
          definitions: [{ definition: "g", synonyms: ["Thing", "stuff", "stuff", 7, "  "] }],
          partOfSpeech: "noun",
          synonyms: ["object"]
        }
      ],
      word: "thing"
    };

    expect(adaptWiktionary([entry])?.partsOfSpeech[0]?.senses[0]?.synonyms).toEqual([
      "stuff",
      "object"
    ]);
  });

  it("caps the senses per part of speech at six", () => {
    const definitions = Array.from({ length: 9 }, (_unused, index) => ({
      definition: `sense ${index + 1}`
    }));
    const entry = { meanings: [{ definitions, partOfSpeech: "noun" }], word: "many" };

    expect(adaptWiktionary([entry])?.partsOfSpeech[0]?.senses).toHaveLength(6);
  });

  it("omits the part-of-speech label and example when absent", () => {
    const entry = { meanings: [{ definitions: [{ definition: "a meaning" }] }], word: "thing" };

    expect(adaptWiktionary([entry])).toEqual({
      partsOfSpeech: [{ senses: [{ definition: "a meaning", examples: [], synonyms: [] }] }],
      pronunciations: []
    });
  });

  it("skips definitions that have no string gloss and meanings with no usable senses", () => {
    const entry = {
      meanings: [
        { definitions: [{ definition: 5 }], partOfSpeech: "noun" },
        { definitions: [{ definition: 5 }, { definition: "a meaning" }], partOfSpeech: "verb" }
      ],
      word: "thing"
    };

    expect(adaptWiktionary([entry])?.partsOfSpeech).toEqual([
      { partOfSpeech: "verb", senses: [{ definition: "a meaning", examples: [], synonyms: [] }] }
    ]);
  });

  it("falls back to the top-level phonetic when no phonetics entry carries text", () => {
    const entry = {
      meanings: [{ definitions: [{ definition: "g" }] }],
      phonetic: "/θɪŋ/",
      phonetics: [{ audio: "a.mp3" }],
      word: "thing"
    };

    expect(adaptWiktionary([entry])?.pronunciations).toEqual([{ ipa: "/θɪŋ/" }]);
  });

  it("yields no pronunciations when neither a phonetic nor any phonetics text exists", () => {
    const entry = {
      meanings: [{ definitions: [{ definition: "g" }] }],
      phonetics: [{ audio: "a.mp3" }],
      word: "thing"
    };

    expect(adaptWiktionary([entry])?.pronunciations).toEqual([]);
  });

  it("returns null when the payload is the no-match object shape", () => {
    expect(adaptWiktionary({ title: "No Definitions Found" })).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(adaptWiktionary([])).toBeNull();
  });

  it("returns null when the leading entry has no word", () => {
    expect(adaptWiktionary([{ meanings: [{ definitions: [{ definition: "g" }] }] }])).toBeNull();
  });

  it("returns an entry with no parts of speech when there are no usable senses", () => {
    expect(adaptWiktionary([{ meanings: [], word: "thing" }])).toEqual({
      partsOfSpeech: [],
      pronunciations: []
    });
  });
});

describe("createFreeDictionaryProvider", () => {
  it("requests the dictionaryapi.dev English endpoint and normalizes the result", async () => {
    const httpClient = fakeHttpClient({ ok: true, value: [cannedEntry] });
    const provider = createFreeDictionaryProvider({ httpClient });

    const result = await provider.lookup("set");

    expect(result?.partsOfSpeech[0]?.partOfSpeech).toBe("verb");
    expect(httpClient.lastUrl()).toBe("https://api.dictionaryapi.dev/api/v2/entries/en/set");
  });

  it("returns null when the transport reports a failure", async () => {
    const httpClient = fakeHttpClient({ error: { kind: "network" }, ok: false });
    const provider = createFreeDictionaryProvider({ httpClient });

    expect(await provider.lookup("absent")).toBeNull();
  });

  it("bounds the request with a positive timeout so an unreachable host cannot hang the lookup", async () => {
    const httpClient = fakeHttpClient({ ok: true, value: [cannedEntry] });

    await createFreeDictionaryProvider({ httpClient }).lookup("set");

    const timeoutMs = httpClient.lastTimeoutMs();
    expect(typeof timeoutMs).toBe("number");
    expect(timeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(timeoutMs)).toBe(true);
  });

  it("resolves to null (not a hang) when the host never responds, via the timeout (#193)", async () => {
    // A fetch that never settles on its own and only rejects when aborted — exactly how an
    // unreachable/slow host behaves under the client's AbortController timeout. Without the bounded
    // request this lookup would hang forever (the bug); with it, the timeout aborts and we fall back.
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const provider = createFreeDictionaryProvider({
      httpClient: createHttpClient(hangingFetch),
      timeoutMs: 20
    });

    expect(await provider.lookup("quick")).toBeNull();
  });
});
