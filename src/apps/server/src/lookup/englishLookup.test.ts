import { describe, expect, it } from "vitest";

import {
  composeWiktionaryEntry,
  composeWordNetEntry,
  createWiktionaryEntryLookup,
  createWordNetEntryLookup
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
    }
  ],
  pronunciations: [{ ipa: "/sɛt/" }]
};

const wordNet: WordNetResult = {
  partsOfSpeech: [
    {
      partOfSpeech: "verb",
      senses: [{ definition: "a WordNet verb", examples: [], synonyms: ["position"] }]
    }
  ]
};

describe("composeWordNetEntry", () => {
  it("builds a WordNet-only entry crediting WordNet, no pronunciation", () => {
    expect(composeWordNetEntry("set", wordNet)).toEqual({
      headword: "set",
      partsOfSpeech: wordNet.partsOfSpeech,
      pronunciations: [],
      sources: [wordNetSource]
    });
  });

  it("returns null when WordNet has no senses", () => {
    expect(composeWordNetEntry("set", null)).toBeNull();
    expect(composeWordNetEntry("set", { partsOfSpeech: [] })).toBeNull();
  });
});

describe("composeWiktionaryEntry", () => {
  it("builds a Wiktionary-only entry with pronunciation/etymology crediting Wiktionary", () => {
    expect(composeWiktionaryEntry("set", wiktionary)).toEqual({
      etymology: "Old English settan.",
      headword: "set",
      partsOfSpeech: wiktionary.partsOfSpeech,
      pronunciations: [{ ipa: "/sɛt/" }],
      sources: [wiktionarySource]
    });
  });

  it("omits etymology when absent and returns null with no senses", () => {
    const entry = composeWiktionaryEntry("set", {
      partsOfSpeech: wiktionary.partsOfSpeech,
      pronunciations: []
    });
    expect(entry?.etymology).toBeUndefined();
    expect(composeWiktionaryEntry("set", null)).toBeNull();
    expect(composeWiktionaryEntry("set", { partsOfSpeech: [], pronunciations: [] })).toBeNull();
  });
});

describe("source lookups", () => {
  const fakeWiktionary = (r: WiktionaryResult | null): WiktionaryProvider => ({
    lookup: () => Promise.resolve(r)
  });
  const fakeWordNet = (r: WordNetResult | null): WordNetProvider => ({
    lookup: () => Promise.resolve(r)
  });

  it("each source composes only its own entry", async () => {
    expect((await createWordNetEntryLookup(fakeWordNet(wordNet))("set"))?.sources).toEqual([
      wordNetSource
    ]);
    expect((await createWiktionaryEntryLookup(fakeWiktionary(wiktionary))("set"))?.sources).toEqual(
      [wiktionarySource]
    );
  });

  it("resolves null when its source has no entry", async () => {
    expect(await createWordNetEntryLookup(fakeWordNet(null))("zzz")).toBeNull();
    expect(await createWiktionaryEntryLookup(fakeWiktionary(null))("zzz")).toBeNull();
  });
});
