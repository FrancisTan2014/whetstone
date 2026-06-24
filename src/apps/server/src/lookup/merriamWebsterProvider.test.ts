import { describe, expect, it } from "vitest";

import type { HttpClient, HttpResult } from "./httpClient.js";
import {
  adaptMerriamWebster,
  createMerriamWebsterProvider,
  merriamWebsterAttributions
} from "./merriamWebsterProvider.js";

// A canned Learner's Dictionary entry with the verbose fields the adapter reads, including
// a `def`/`sseq` tree the example extractor walks. Both MW references share this shape.
const cannedEntry = {
  def: [
    {
      sseq: [
        [
          [
            "sense",
            {
              dt: [
                ["text", "{bc}having or containing a large amount "],
                // The first illustration lacks `t` (skipped); the second supplies it.
                ["vis", [{ aq: {} }, { t: "a {it}voluminous{/it} report" }]]
              ]
            }
          ]
        ],
        [
          // A non-"sense" tuple (binding substitute) is skipped before the next sense.
          ["bs", { sense: {} }],
          ["sense", { dt: [["text", "{bc}very full or large"]] }]
        ]
      ]
    }
  ],
  fl: "adjective",
  hwi: {
    hw: "vo*lu*mi*nous",
    prs: [{ mw: "və-ˈlü-mə-nəs", sound: { audio: "x" } }]
  },
  meta: { id: "voluminous" },
  shortdef: [
    "having or containing a large amount",
    "very full or large",
    "of, relating to, or filling a large volume",
    "a fourth sense that must be dropped"
  ]
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

describe("adaptMerriamWebster", () => {
  it("normalizes the entry, stripping syllable breaks, capping senses, and attaching the first vis example", () => {
    expect(adaptMerriamWebster([cannedEntry])).toEqual({
      headword: "voluminous",
      pronunciation: "və-ˈlü-mə-nəs",
      senses: [
        {
          example: "a voluminous report",
          gloss: "having or containing a large amount",
          partOfSpeech: "adjective"
        },
        { gloss: "very full or large", partOfSpeech: "adjective" },
        { gloss: "of, relating to, or filling a large volume", partOfSpeech: "adjective" }
      ]
    });
  });

  it("normalizes a Collegiate entry of the same shape", () => {
    const collegiate = {
      fl: "noun",
      hwi: { hw: "lex*i*con", prs: [{ mw: "ˈlek-sə-ˌkän" }] },
      shortdef: ["the vocabulary of a language"]
    };

    expect(adaptMerriamWebster([collegiate])).toEqual({
      headword: "lexicon",
      pronunciation: "ˈlek-sə-ˌkän",
      senses: [{ gloss: "the vocabulary of a language", partOfSpeech: "noun" }]
    });
  });

  it("omits the part of speech when the entry has no functional label", () => {
    const entry = { hwi: { hw: "word" }, shortdef: ["a unit of language"] };

    expect(adaptMerriamWebster([entry])).toEqual({
      headword: "word",
      senses: [{ gloss: "a unit of language" }]
    });
  });

  it("reads the pronunciation from the first prs entry's `mw` form", () => {
    const entry = {
      fl: "noun",
      hwi: { hw: "word", prs: [{ mw: "wərd" }, { mw: "ignored" }] },
      shortdef: ["meaning"]
    };

    expect(adaptMerriamWebster([entry])?.pronunciation).toBe("wərd");
  });

  it("omits pronunciation when the first prs entry has no `mw` form", () => {
    const entry = { fl: "noun", hwi: { hw: "word", prs: [{ sound: {} }] }, shortdef: ["meaning"] };

    expect(adaptMerriamWebster([entry])?.pronunciation).toBeUndefined();
  });

  it("omits the example when a sense has a dt but no vis illustration", () => {
    const entry = {
      def: [{ sseq: [[["sense", { dt: [["text", "{bc}plain gloss"]] }]]] }],
      hwi: { hw: "word" },
      shortdef: ["plain gloss"]
    };

    expect(adaptMerriamWebster([entry])?.senses).toEqual([{ gloss: "plain gloss" }]);
  });

  it("ignores non-string short definitions", () => {
    const entry = { hwi: { hw: "word" }, shortdef: ["good", 42, "great"] };

    expect(adaptMerriamWebster([entry])?.senses).toEqual([{ gloss: "good" }, { gloss: "great" }]);
  });

  it("returns null when the payload is not the expected array shape", () => {
    expect(adaptMerriamWebster({ title: "No Definitions" })).toBeNull();
  });

  it("returns null for a suggestions-only response (strings and nulls, no entry objects)", () => {
    expect(adaptMerriamWebster([null, "volume", "voluminously"])).toBeNull();
  });

  it("returns null when the first entry has no headword", () => {
    expect(adaptMerriamWebster([{ fl: "noun", shortdef: ["meaning"] }])).toBeNull();
  });

  it("returns null when the entry has no short definitions", () => {
    expect(adaptMerriamWebster([{ hwi: { hw: "word" }, shortdef: [] }])).toBeNull();
  });
});

describe("createMerriamWebsterProvider", () => {
  it("requests the Learner's API with the key and returns the normalized entry", async () => {
    const httpClient = fakeHttpClient({ ok: true, value: [cannedEntry] });
    const provider = createMerriamWebsterProvider({
      apiKey: "secret-key",
      httpClient,
      reference: "learners"
    });

    const entry = await provider.lookup("voluminous", "en");

    expect(entry?.headword).toBe("voluminous");
    expect(httpClient.lastUrl()).toContain(
      "https://www.dictionaryapi.com/api/v3/references/learners/json/voluminous"
    );
    expect(httpClient.lastUrl()).toContain("key=secret-key");
  });

  it("requests the Collegiate reference path when configured for it", async () => {
    const httpClient = fakeHttpClient({ ok: true, value: [cannedEntry] });
    const provider = createMerriamWebsterProvider({
      apiKey: "coll-key",
      httpClient,
      reference: "collegiate"
    });

    await provider.lookup("voluminous", "en");

    expect(httpClient.lastUrl()).toContain(
      "https://www.dictionaryapi.com/api/v3/references/collegiate/json/voluminous"
    );
  });

  it("returns null when the transport reports a failure", async () => {
    const httpClient = fakeHttpClient({ error: { kind: "http", status: 404 }, ok: false });
    const provider = createMerriamWebsterProvider({
      apiKey: "k",
      httpClient,
      reference: "learners"
    });

    expect(await provider.lookup("absent", "en")).toBeNull();
  });
});

describe("merriamWebsterAttributions", () => {
  it("names each reference's dictionary as required", () => {
    expect(merriamWebsterAttributions.learners).toContain("Learner's Dictionary");
    expect(merriamWebsterAttributions.collegiate).toContain("Collegiate Dictionary");
  });
});
