import { describe, expect, it } from "vitest";

import {
  composeEnglishEntry,
  createEnglishLookup,
  type EnglishLookupDependencies
} from "./englishLookup.js";
import {
  wiktionarySource,
  type WiktionaryProvider,
  type WiktionaryResult
} from "./freeDictionaryProvider.js";
import { wordNetSource, type WordNetProvider, type WordNetResult } from "./wordnetProvider.js";

const wiktionary: WiktionaryResult = {
  etymology: "Old English settan.",
  partsOfSpeech: [
    {
      partOfSpeech: "verb",
      senses: [{ definition: "to put in place", examples: ["set it down"], synonyms: ["place"] }]
    },
    {
      partOfSpeech: "adjective",
      senses: [{ definition: "ready", examples: [], synonyms: ["ready"] }]
    }
  ],
  pronunciations: [{ ipa: "/sɛt/" }]
};

const wordNet: WordNetResult = {
  partsOfSpeech: [
    {
      partOfSpeech: "verb",
      senses: [{ definition: "a WordNet verb", examples: [], synonyms: ["place", "position"] }]
    },
    {
      partOfSpeech: "noun",
      senses: [{ definition: "a WordNet noun", examples: [], synonyms: ["group"] }]
    }
  ]
};

function fakeWiktionary(result: WiktionaryResult | null): WiktionaryProvider {
  return { lookup: () => Promise.resolve(result) };
}

function fakeWordNet(result: WordNetResult | null): WordNetProvider {
  return { lookup: () => Promise.resolve(result) };
}

describe("composeEnglishEntry", () => {
  it("uses Wiktionary senses/pronunciation/etymology and merges WordNet synonyms by part of speech", () => {
    expect(composeEnglishEntry("set", wiktionary, wordNet)).toEqual({
      etymology: "Old English settan.",
      headword: "set",
      partsOfSpeech: [
        {
          partOfSpeech: "verb",
          senses: [
            {
              definition: "to put in place",
              examples: ["set it down"],
              synonyms: ["place", "position"]
            }
          ]
        },
        {
          partOfSpeech: "adjective",
          senses: [{ definition: "ready", examples: [], synonyms: ["ready"] }]
        }
      ],
      pronunciations: [{ ipa: "/sɛt/" }],
      sources: [wiktionarySource, wordNetSource]
    });
  });

  it("falls back to WordNet senses and synonyms when Wiktionary has no entry", () => {
    expect(composeEnglishEntry("set", null, wordNet)).toEqual({
      headword: "set",
      partsOfSpeech: [
        {
          partOfSpeech: "verb",
          senses: [{ definition: "a WordNet verb", examples: [], synonyms: ["place", "position"] }]
        },
        {
          partOfSpeech: "noun",
          senses: [{ definition: "a WordNet noun", examples: [], synonyms: ["group"] }]
        }
      ],
      pronunciations: [],
      sources: [wordNetSource]
    });
  });

  it("uses Wiktionary pronunciation but WordNet senses when Wiktionary lacks senses", () => {
    const entry = composeEnglishEntry(
      "set",
      { partsOfSpeech: [], pronunciations: [{ ipa: "/sɛt/" }] },
      wordNet
    );

    expect(entry?.pronunciations).toEqual([{ ipa: "/sɛt/" }]);
    expect(entry?.partsOfSpeech[0]?.senses[0]?.definition).toBe("a WordNet verb");
    expect(entry?.sources).toEqual([wiktionarySource, wordNetSource]);
  });

  it("keeps only Wiktionary synonyms and credit when WordNet has no entry", () => {
    const entry = composeEnglishEntry("set", wiktionary, null);

    expect(entry?.partsOfSpeech[0]?.senses[0]?.synonyms).toEqual(["place"]);
    expect(entry?.sources).toEqual([wiktionarySource]);
  });

  it("does not merge synonyms into a part-of-speech-less group and skips WordNet groups without a label", () => {
    const wikt: WiktionaryResult = {
      partsOfSpeech: [{ senses: [{ definition: "d", examples: [], synonyms: ["a"] }] }],
      pronunciations: []
    };
    const wn: WordNetResult = {
      partsOfSpeech: [{ senses: [{ definition: "x", examples: [], synonyms: ["ignored"] }] }]
    };

    expect(composeEnglishEntry("w", wikt, wn)?.partsOfSpeech[0]?.senses[0]?.synonyms).toEqual([
      "a"
    ]);
  });

  it("returns null when neither source yields senses", () => {
    expect(composeEnglishEntry("zzz", null, null)).toBeNull();
  });

  it("unions WordNet synonyms across duplicate part-of-speech groups", () => {
    const wn: WordNetResult = {
      partsOfSpeech: [
        { partOfSpeech: "noun", senses: [{ definition: "a", examples: [], synonyms: ["x"] }] },
        { partOfSpeech: "noun", senses: [{ definition: "b", examples: [], synonyms: ["y"] }] }
      ]
    };
    const wikt: WiktionaryResult = {
      partsOfSpeech: [
        { partOfSpeech: "noun", senses: [{ definition: "d", examples: [], synonyms: [] }] }
      ],
      pronunciations: []
    };

    expect(composeEnglishEntry("w", wikt, wn)?.partsOfSpeech[0]?.senses[0]?.synonyms).toEqual([
      "x",
      "y"
    ]);
  });
});

describe("createEnglishLookup", () => {
  const deps = (
    wikt: WiktionaryResult | null,
    wn: WordNetResult | null
  ): EnglishLookupDependencies => ({ wiktionary: fakeWiktionary(wikt), wordNet: fakeWordNet(wn) });

  it("composes the parallel Wiktionary and WordNet results", async () => {
    const entry = await createEnglishLookup(deps(wiktionary, wordNet)).lookup("set");

    expect(entry?.headword).toBe("set");
    expect(entry?.sources).toEqual([wiktionarySource, wordNetSource]);
  });

  it("still resolves via WordNet when Wiktionary is unavailable", async () => {
    const entry = await createEnglishLookup(deps(null, wordNet)).lookup("set");

    expect(entry?.partsOfSpeech[0]?.senses[0]?.synonyms).toEqual(["place", "position"]);
    expect(entry?.sources).toEqual([wordNetSource]);
  });

  it("resolves null when neither source has the word", async () => {
    expect(await createEnglishLookup(deps(null, null)).lookup("zzz")).toBeNull();
  });
});
