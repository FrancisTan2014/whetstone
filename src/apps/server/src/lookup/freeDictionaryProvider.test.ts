import { describe, expect, it } from "vitest";

import { adaptFreeDictionary, createFreeDictionaryProvider } from "./freeDictionaryProvider.js";
import type { HttpClient, HttpResult } from "./httpClient.js";

const cannedEntry = {
  meanings: [
    {
      definitions: [
        { definition: "to put something in a specified place", example: "set it down" },
        { definition: "to fix firmly" }
      ],
      partOfSpeech: "verb"
    },
    {
      definitions: [
        { definition: "a group of similar things", example: "a chess set" },
        { definition: "a fourth sense that must be dropped" }
      ],
      partOfSpeech: "noun"
    }
  ],
  phonetic: "/sɛt/",
  phonetics: [{ text: "/sɛt/" }],
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

describe("adaptFreeDictionary", () => {
  it("flattens meanings into capped senses with parts of speech and examples", () => {
    expect(adaptFreeDictionary([cannedEntry])).toEqual({
      headword: "set",
      pronunciation: "/sɛt/",
      senses: [
        {
          example: "set it down",
          gloss: "to put something in a specified place",
          partOfSpeech: "verb"
        },
        { gloss: "to fix firmly", partOfSpeech: "verb" },
        { example: "a chess set", gloss: "a group of similar things", partOfSpeech: "noun" }
      ]
    });
  });

  it("omits the part of speech and example when absent", () => {
    const entry = { meanings: [{ definitions: [{ definition: "a meaning" }] }], word: "thing" };

    expect(adaptFreeDictionary([entry])).toEqual({
      headword: "thing",
      senses: [{ gloss: "a meaning" }]
    });
  });

  it("skips definitions that have no string gloss", () => {
    const entry = {
      meanings: [{ definitions: [{ definition: 5 }, { definition: "a meaning" }] }],
      word: "thing"
    };

    expect(adaptFreeDictionary([entry])?.senses).toEqual([{ gloss: "a meaning" }]);
  });

  it("falls back to a phonetics entry's text when no top-level phonetic is given", () => {
    const entry = {
      meanings: [{ definitions: [{ definition: "g" }] }],
      phonetics: [{ audio: "a.mp3" }, { text: "/θɪŋ/" }],
      word: "thing"
    };

    expect(adaptFreeDictionary([entry])?.pronunciation).toBe("/θɪŋ/");
  });

  it("omits pronunciation when neither a phonetic nor any phonetics text exists", () => {
    const entry = {
      meanings: [{ definitions: [{ definition: "g" }] }],
      phonetics: [{ audio: "a.mp3" }],
      word: "thing"
    };

    expect(adaptFreeDictionary([entry])?.pronunciation).toBeUndefined();
  });

  it("returns null when the payload is the no-match object shape", () => {
    expect(adaptFreeDictionary({ title: "No Definitions Found" })).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(adaptFreeDictionary([])).toBeNull();
  });

  it("returns null when the leading entry has no word", () => {
    expect(
      adaptFreeDictionary([{ meanings: [{ definitions: [{ definition: "g" }] }] }])
    ).toBeNull();
  });

  it("returns null when the entry has no usable senses", () => {
    expect(adaptFreeDictionary([{ meanings: [], word: "thing" }])).toBeNull();
  });
});

describe("createFreeDictionaryProvider", () => {
  it("requests the dictionaryapi.dev English endpoint and normalizes the result", async () => {
    const httpClient = fakeHttpClient({ ok: true, value: [cannedEntry] });
    const provider = createFreeDictionaryProvider({ httpClient });

    const entry = await provider.lookup("set", "en");

    expect(entry?.headword).toBe("set");
    expect(httpClient.lastUrl()).toBe("https://api.dictionaryapi.dev/api/v2/entries/en/set");
  });

  it("returns null when the transport reports a failure", async () => {
    const httpClient = fakeHttpClient({ error: { kind: "network" }, ok: false });
    const provider = createFreeDictionaryProvider({ httpClient });

    expect(await provider.lookup("absent", "en")).toBeNull();
  });
});
