import { describe, expect, it } from "vitest";

import { adaptWiktionary, createFreeDictionaryProvider } from "./freeDictionaryProvider.js";
import type { HttpClient, HttpResult } from "./httpClient.js";

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

function fakeHttpClient(result: HttpResult<unknown>): HttpClient & { lastUrl: () => string } {
  let requestedUrl = "";
  return {
    getJson: <T>(url: string): Promise<HttpResult<T>> => {
      requestedUrl = url;
      return Promise.resolve(result as HttpResult<T>);
    },
    getText: () => Promise.resolve({ error: { kind: "network" }, ok: false }),
    lastUrl: () => requestedUrl
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
});
