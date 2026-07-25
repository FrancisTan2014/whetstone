import WordPOS from "wordpos";
import { describe, expect, it } from "vitest";

import type { LexicalPartOfSpeech, LexicalRelationType } from "@whetstone/domain";

import type { LexicalLemmatizer } from "./lexicalLemmatizer.js";
import { winkLemmatizer } from "./lexicalLemmatizer.js";
import {
  classifyContextRelation,
  collectLexicalSenses,
  createWordNetLexical,
  resolveSenseRelations,
  type LexicalRawSynset,
  type LexicalWordNet,
  type WordPosSeekLike
} from "./wordnetLexicalProvider.js";

// #715 WordNet traversal. The bulk of these tests run against an in-memory fake so every branch of sense
// collection and one-hop relation resolution is asserted deterministically: dedupe, POS restriction, lexical
// source-index gating, semantic all-lemma expansion, and the silent skips (unknown pointer, malformed
// indices, missing target, sense-not-found). A final block wraps the REAL bundled WordNet database to prove
// the same seam narrows untrusted records and resolves a common word offline. No writes anywhere.

// A deterministic lemmatizer keyed by an explicit table; unknown pairs echo the surface (matching wink's
// harmless over-generation) so inflection is decided only where the table declares it.
const LEMMA_TABLE: Readonly<Record<string, string>> = {
  "cars|noun": "car",
  "mice|noun": "mouse"
};
const fakeLemmatize: LexicalLemmatizer = (surface, pos) =>
  LEMMA_TABLE[`${surface}|${pos}`] ?? surface;

function synset(
  offset: string,
  pos: string,
  synonyms: readonly string[],
  pointers: LexicalRawSynset["pointers"] = []
): LexicalRawSynset {
  return {
    synsetOffset: offset,
    pos,
    synonyms,
    definition: `${offset} gloss`,
    examples: [],
    pointers
  };
}

const CAR = synset(
  "car1",
  "n",
  ["car", "auto", "automobile"],
  [
    { symbol: "@", synsetOffset: "mv1", pos: "n", sourceTarget: "0000" },
    { symbol: "@", synsetOffset: "ghost", pos: "n", sourceTarget: "0000" },
    { symbol: "~", synsetOffset: "cab1", pos: "n", sourceTarget: "0000" },
    { symbol: "~", synsetOffset: "extra1", pos: "n", sourceTarget: "zzzz" },
    { symbol: "+", synsetOffset: "drive1", pos: "v", sourceTarget: "0102" },
    { symbol: "+", synsetOffset: "drive1", pos: "v", sourceTarget: "0109" },
    { symbol: "!", synsetOffset: "hate1", pos: "n", sourceTarget: "0201" },
    { symbol: "!", synsetOffset: "ghostlex", pos: "v", sourceTarget: "0101" },
    { symbol: "%", synsetOffset: "part1", pos: "n", sourceTarget: "0000" }
  ]
);

const SEEKABLE = new Map<string, LexicalRawSynset>([
  ["n:car1", CAR],
  ["n:mv1", synset("mv1", "n", ["motor_vehicle", "machine"])],
  ["n:cab1", synset("cab1", "n", ["cab", "taxi"])],
  ["n:extra1", synset("extra1", "n", ["extraword"])],
  ["v:drive1", synset("drive1", "v", ["drive", "driving"])],
  ["n:part1", synset("part1", "n", ["wheel"])]
]);

const LOOKUPS = new Map<string, readonly LexicalRawSynset[]>([
  ["car", [CAR]],
  ["mouse", [synset("mouse1", "n", ["mouse"]), synset("mouse2", "v", ["mouse"])]],
  ["run", [synset("run1", "v", ["run"]), synset("run2", "n", ["run"])]],
  ["quickly", [synset("q1", "r", ["quickly"])]],
  ["weird", [synset("weird1", "x", ["weird"])]]
]);

const fakeWordNet: LexicalWordNet = {
  lookup: (surface) => Promise.resolve(LOOKUPS.get(surface) ?? []),
  seek: (offset, pos) => Promise.resolve(SEEKABLE.get(`${pos}:${offset}`) ?? null)
};

const NOUN: LexicalPartOfSpeech = "noun";

describe("collectLexicalSenses", () => {
  it("returns nothing for an empty surface (skips empty queries)", async () => {
    expect(await collectLexicalSenses(fakeWordNet, "", fakeLemmatize)).toEqual([]);
  });

  it("collects the direct surface sense with deduped single-word lemma keys", async () => {
    const senses = await collectLexicalSenses(fakeWordNet, "car", fakeLemmatize);
    expect(senses).toHaveLength(1);
    expect(senses[0]?.partOfSpeech).toBe("noun");
    // motor_vehicle-style multiword synonyms are dropped; car keeps its single-word co-lemmas.
    expect(senses[0]?.lemmas).toEqual(["car", "auto", "automobile"]);
  });

  it("restricts a lemma candidate to its part of speech", async () => {
    // "mice" has no direct entry; the noun lemma "mouse" yields a noun and a verb sense, but the noun
    // restriction drops the verb sense.
    const senses = await collectLexicalSenses(fakeWordNet, "mice", fakeLemmatize);
    expect(senses.map((sense) => `${sense.partOfSpeech}:${sense.offset}`)).toEqual(["noun:mouse1"]);
  });

  it("dedupes a synset reached by both the surface and a lemma candidate", async () => {
    const senses = await collectLexicalSenses(fakeWordNet, "run", fakeLemmatize);
    // Direct lookup contributes both; the noun-lemma pass re-reaches run2 but does not double-count.
    expect(senses.map((sense) => `${sense.partOfSpeech}:${sense.offset}`)).toEqual([
      "verb:run1",
      "noun:run2"
    ]);
  });

  it("captures an adverb sense through the direct surface path", async () => {
    const senses = await collectLexicalSenses(fakeWordNet, "quickly", fakeLemmatize);
    expect(senses.map((sense) => sense.partOfSpeech)).toEqual(["adverb"]);
  });

  it("skips a synset whose part-of-speech code is unknown", async () => {
    expect(await collectLexicalSenses(fakeWordNet, "weird", fakeLemmatize)).toEqual([]);
  });
});

function keysOf(
  sets: ReadonlyMap<LexicalRelationType, ReadonlySet<string>>,
  type: LexicalRelationType
): string[] {
  return [...(sets.get(type) ?? new Set<string>())].sort();
}

describe("resolveSenseRelations", () => {
  it("returns null when the selected sense does not exist", async () => {
    const context = await resolveSenseRelations(
      fakeWordNet,
      "car",
      { offset: "nope", partOfSpeech: NOUN },
      fakeLemmatize
    );
    expect(context).toBeNull();
  });

  it("returns null when the surface does not belong to the selected sense", async () => {
    const context = await resolveSenseRelations(
      fakeWordNet,
      "banana",
      { offset: "car1", partOfSpeech: NOUN },
      fakeLemmatize
    );
    expect(context).toBeNull();
  });

  it("resolves synonyms, semantic hyper/hyponyms, and the gated lexical derivation", async () => {
    const context = await resolveSenseRelations(
      fakeWordNet,
      "car",
      { offset: "car1", partOfSpeech: NOUN },
      fakeLemmatize
    );
    expect(context).not.toBeNull();
    if (context === null) {
      return;
    }
    expect(context.selectedLemma).toBe("car");
    expect(context.partOfSpeech).toBe("noun");
    // Same-synset synonyms, minus the selected lemma.
    expect(keysOf(context.relationSets, "synonym")).toEqual(["auto", "automobile"]);
    // Hypernym expands every single-word lemma of the direct target; the missing "ghost" target is skipped
    // and the multiword "motor_vehicle" lemma is dropped.
    expect(keysOf(context.relationSets, "hypernym")).toEqual(["machine"]);
    // Hyponym follows the well-formed pointer; the malformed-index "extra1" pointer is skipped, so
    // "extraword" never leaks.
    expect(keysOf(context.relationSets, "hyponym")).toEqual(["cab", "taxi"]);
    // The lexical derivation fires from the selected word index and resolves the specific target word.
    expect(keysOf(context.relationSets, "derivation")).toEqual(["driving"]);
    // The antonym pointer leaves from word 2 (auto), not the selected word 1, so it is gated out; the
    // meronym "%" pointer is an excluded symbol; neither contributes.
    expect(context.relationSets.has("antonym")).toBe(false);
    expect(keysOf(context.relationSets, "hyponym")).not.toContain("wheel");
  });
});

describe("classifyContextRelation", () => {
  it("types an existing surface against a resolved sense, honoring exclusion, inflection, and priority", async () => {
    const context = await resolveSenseRelations(
      fakeWordNet,
      "car",
      { offset: "car1", partOfSpeech: NOUN },
      fakeLemmatize
    );
    if (context === null) {
      throw new Error("expected a resolved context");
    }
    // Exact material (the queried surface) is excluded.
    expect(classifyContextRelation(context, "car", fakeLemmatize)).toBeNull();
    // An inflected form of the selected lemma is inflection, ahead of any set membership.
    expect(classifyContextRelation(context, "cars", fakeLemmatize)).toBe("inflection");
    // Set membership by relation.
    expect(classifyContextRelation(context, "auto", fakeLemmatize)).toBe("synonym");
    expect(classifyContextRelation(context, "machine", fakeLemmatize)).toBe("hypernym");
    expect(classifyContextRelation(context, "cab", fakeLemmatize)).toBe("hyponym");
    expect(classifyContextRelation(context, "driving", fakeLemmatize)).toBe("derivation");
    // An unrelated surface types to nothing.
    expect(classifyContextRelation(context, "banana", fakeLemmatize)).toBeNull();
  });
});

describe("createWordNetLexical narrowing", () => {
  it("narrows untrusted records and drops malformed synsets/pointers", async () => {
    const raw: WordPosSeekLike = {
      lookup: () =>
        Promise.resolve([
          {
            synsetOffset: "01",
            pos: "n",
            synonyms: ["car", 7, "auto"],
            def: "a car",
            exp: ["drove the car"],
            ptrs: [
              { pointerSymbol: "@", synsetOffset: "02", pos: "n", sourceTarget: "0000" },
              { pointerSymbol: "!", synsetOffset: "03", pos: "n" }, // missing sourceTarget → dropped
              null // non-record pointer → dropped
            ]
          },
          { synsetOffset: "05", pos: "n" }, // valid but def-less → definition defaults to ""
          { pos: "n" }, // missing synsetOffset → dropped
          null // non-record synset → dropped
        ]),
      seek: () => Promise.resolve({})
    };
    const wordnet = createWordNetLexical(raw);
    const synsets = await wordnet.lookup("car");
    expect(synsets).toHaveLength(2);
    expect(synsets[0]?.synonyms).toEqual(["car", "auto"]);
    expect(synsets[0]?.pointers).toEqual([
      { symbol: "@", synsetOffset: "02", pos: "n", sourceTarget: "0000" }
    ]);
    // A record with no `def` narrows to an empty definition, never undefined.
    expect(synsets[1]?.definition).toBe("");
    // An unnarrowable seek record resolves to null rather than throwing.
    expect(await wordnet.seek("missing", "n")).toBeNull();
  });

  it("is frozen so the seam cannot be mutated", () => {
    expect(
      Object.isFrozen(createWordNetLexical({ lookup: async () => [], seek: async () => null }))
    ).toBe(true);
  });
});

// One offline integration test against the real bundled WordNet database, using the production lemmatizer:
// it must narrow the untrusted records and resolve a common word's senses and a one-hop relation.
describe("WordNet lexical offline integration", () => {
  it("collects senses and resolves a direct hypernym for a common noun", async () => {
    const wordnet = createWordNetLexical(new WordPOS() as unknown as WordPosSeekLike);
    const senses = await collectLexicalSenses(wordnet, "car", winkLemmatizer);
    expect(senses.length).toBeGreaterThan(0);

    const nounSense = senses.find((sense) => sense.partOfSpeech === "noun");
    expect(nounSense).toBeDefined();
    if (nounSense === undefined) {
      return;
    }
    const context = await resolveSenseRelations(
      wordnet,
      "car",
      { offset: nounSense.offset, partOfSpeech: "noun" },
      winkLemmatizer
    );
    expect(context).not.toBeNull();
    if (context === null) {
      return;
    }
    // "car"'s direct hypernym in WordNet is "motor_vehicle" (multiword, so no single-word key), but the
    // sense must resolve with at least one typed relation set populated (synonyms or a taxonomy hop).
    const populated = [...context.relationSets.values()].some((set) => set.size > 0);
    expect(populated).toBe(true);
  });
});
