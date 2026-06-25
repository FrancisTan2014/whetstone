import WordPOS from "wordpos";
import { describe, expect, it } from "vitest";

import {
  createWordNetProvider,
  mapWordNetSynsets,
  type WordNetSynset,
  type WordPosLike
} from "./wordnetProvider.js";

const nounSynset: WordNetSynset = {
  def: "a domesticated carnivore",
  exp: ["the dog barked all night"],
  pos: "n",
  synonyms: ["dog", "domestic_dog", "Canis_familiaris"]
};

const verbSynset: WordNetSynset = {
  def: "to pursue relentlessly",
  exp: [],
  pos: "v",
  synonyms: ["chase", "track(p)"]
};

function fakeWordPos(result: ReadonlyArray<WordNetSynset> | Error): WordPosLike {
  return {
    lookup: (): Promise<ReadonlyArray<WordNetSynset>> =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  };
}

describe("mapWordNetSynsets", () => {
  it("groups synsets by part of speech and cleans synonyms (markers, underscores, headword)", () => {
    expect(mapWordNetSynsets([nounSynset, verbSynset], "dog")).toEqual({
      partsOfSpeech: [
        {
          partOfSpeech: "noun",
          senses: [
            {
              definition: "a domesticated carnivore",
              examples: ["the dog barked all night"],
              synonyms: ["domestic dog", "Canis familiaris"]
            }
          ]
        },
        {
          partOfSpeech: "verb",
          senses: [
            { definition: "to pursue relentlessly", examples: [], synonyms: ["chase", "track"] }
          ]
        }
      ]
    });
  });

  it("merges adjective and satellite codes into one group and maps adverbs", () => {
    const groups = mapWordNetSynsets(
      [
        { def: "free from danger", exp: [], pos: "a", synonyms: ["safe"] },
        { def: "secure from harm", exp: [], pos: "s", synonyms: ["secure"] },
        { def: "in a safe manner", exp: [], pos: "r", synonyms: ["safely"] }
      ],
      "safe"
    );

    expect(groups?.partsOfSpeech.map((part) => part.partOfSpeech)).toEqual(["adjective", "adverb"]);
    expect(groups?.partsOfSpeech[0]?.senses).toHaveLength(2);
  });

  it("skips synsets with an unknown part of speech or no definition", () => {
    const groups = mapWordNetSynsets(
      [
        { def: "a usable noun", exp: [], pos: "n", synonyms: [] },
        { def: "no part of speech", exp: [], pos: "x", synonyms: [] },
        { def: "missing pos field", exp: [], synonyms: [] },
        { exp: [], pos: "n", synonyms: ["missing def"] }
      ],
      "thing"
    );

    expect(groups?.partsOfSpeech).toEqual([
      {
        partOfSpeech: "noun",
        senses: [{ definition: "a usable noun", examples: [], synonyms: [] }]
      }
    ]);
  });

  it("caps senses per part of speech at six", () => {
    const synsets = Array.from({ length: 9 }, (_unused, index) => ({
      def: `sense ${index + 1}`,
      exp: [],
      pos: "n",
      synonyms: []
    }));

    expect(mapWordNetSynsets(synsets, "many")?.partsOfSpeech[0]?.senses).toHaveLength(6);
  });

  it("returns null when no synset is usable", () => {
    expect(mapWordNetSynsets([], "x")).toBeNull();
  });

  it("drops non-string and marker-only synonyms, dedupes, and skips non-string examples", () => {
    const result = mapWordNetSynsets(
      [
        {
          def: "a definition",
          exp: ["a valid example", 9],
          pos: "n",
          synonyms: ["alpha", "alpha", "(p)", 5, "thing"]
        }
      ],
      "thing"
    );

    expect(result?.partsOfSpeech[0]?.senses[0]).toEqual({
      definition: "a definition",
      examples: ["a valid example"],
      synonyms: ["alpha"]
    });
  });
});

describe("createWordNetProvider", () => {
  it("maps the wordpos result into grouped senses", async () => {
    const provider = createWordNetProvider(fakeWordPos([nounSynset]));

    const result = await provider.lookup("dog");

    expect(result?.partsOfSpeech[0]?.partOfSpeech).toBe("noun");
  });

  it("returns null when wordpos has no entry for the term", async () => {
    expect(await createWordNetProvider(fakeWordPos([])).lookup("zzz")).toBeNull();
  });

  it("returns null when the wordpos lookup rejects", async () => {
    expect(
      await createWordNetProvider(fakeWordPos(new Error("unreadable"))).lookup("dog")
    ).toBeNull();
  });
});

// One integration test against the real bundled WordNet database — no network — proving the
// offline backbone resolves a common word with senses and synonyms.
describe("WordNet offline integration", () => {
  it("resolves a common word from the bundled database", async () => {
    const provider = createWordNetProvider(new WordPOS() as unknown as WordPosLike);

    const result = await provider.lookup("dog");
    const senses = result?.partsOfSpeech.flatMap((part) => part.senses) ?? [];

    expect(result).not.toBeNull();
    expect(senses.length).toBeGreaterThan(0);
    expect(senses.some((sense) => sense.synonyms.length > 0)).toBe(true);
  });
});
