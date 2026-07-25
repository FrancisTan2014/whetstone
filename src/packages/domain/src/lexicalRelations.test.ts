import { describe, expect, it } from "vitest";

import {
  classifyLexicalRelation,
  classifyWordNetPointer,
  LEXICAL_RELATION_PRIORITY,
  lexicalPosCode,
  lexicalPosFromCode,
  lexicalRelationFacet,
  MAX_NOTES_PER_RELATION,
  normalizeLemmaKey,
  normalizeLexicalSurface,
  parsePointerWordIndices,
  type LexicalPartOfSpeech,
  type LexicalRelationType
} from "./lexicalRelations.js";

// Pure foundation for #715: every exported string/normalization/classification helper is exercised here
// without WordNet, the lemmatizer, or a database. The assertions target the risky boundaries — eligibility,
// pointer typing, malformed input, priority — so a planted bug in the classification logic fails a test.

describe("normalizeLexicalSurface", () => {
  it("accepts a single ASCII word and folds case + NFC", () => {
    expect(normalizeLexicalSurface("  Car  ")).toBe("car");
    expect(normalizeLexicalSurface("HOT")).toBe("hot");
    // NFC composes the decomposed café-like form, but a non-ASCII letter is still ineligible; a plain word
    // with internal apostrophe/hyphen is accepted.
    expect(normalizeLexicalSurface("don't")).toBe("don't");
    expect(normalizeLexicalSurface("well-known")).toBe("well-known");
  });

  it("rejects phrases, numbers, symbols, emoji, and non-ASCII scripts", () => {
    for (const raw of [
      "ice cream",
      "C++",
      "007",
      "v2",
      "100%",
      "🚀",
      "你好",
      "Москва",
      "résumé",
      "",
      "-lead",
      "trail-",
      "a--b"
    ]) {
      expect(normalizeLexicalSurface(raw)).toBeNull();
    }
  });
});

describe("lexicalPosCode / lexicalPosFromCode", () => {
  it("maps every open class to its WordNet letter and back", () => {
    const pairs: ReadonlyArray<[LexicalPartOfSpeech, string]> = [
      ["noun", "n"],
      ["verb", "v"],
      ["adjective", "a"],
      ["adverb", "r"]
    ];
    for (const [pos, code] of pairs) {
      expect(lexicalPosCode(pos)).toBe(code);
      expect(lexicalPosFromCode(code)).toBe(pos);
    }
  });

  it("folds the adjective satellite code into adjective and rejects unknown codes", () => {
    expect(lexicalPosFromCode("s")).toBe("adjective");
    expect(lexicalPosFromCode("x")).toBeNull();
    expect(lexicalPosFromCode("")).toBeNull();
  });
});

describe("classifyWordNetPointer", () => {
  it("types only the four traversed pointer families with correct facets", () => {
    expect(classifyWordNetPointer("!")).toEqual({
      type: "antonym",
      facet: { direction: "lateral", source: "lexical" }
    });
    expect(classifyWordNetPointer("+")).toEqual({
      type: "derivation",
      facet: { direction: "lateral", source: "lexical" }
    });
    for (const symbol of ["@", "@i"]) {
      expect(classifyWordNetPointer(symbol)).toEqual({
        type: "hypernym",
        facet: { direction: "broader", source: "semantic" }
      });
    }
    for (const symbol of ["~", "~i"]) {
      expect(classifyWordNetPointer(symbol)).toEqual({
        type: "hyponym",
        facet: { direction: "narrower", source: "semantic" }
      });
    }
  });

  it("excludes every non-traversed pointer symbol", () => {
    for (const symbol of ["%", "#", "*", ">", "^", "=", "&", "\\", ";", "-", "$", "<", "", "?"]) {
      expect(classifyWordNetPointer(symbol)).toBeNull();
    }
  });
});

describe("parsePointerWordIndices", () => {
  it("parses four hex digits into 1-based source/target word numbers", () => {
    expect(parsePointerWordIndices("0000")).toEqual({ source: 0, target: 0 });
    expect(parsePointerWordIndices("0102")).toEqual({ source: 1, target: 2 });
    expect(parsePointerWordIndices("0a0f")).toEqual({ source: 10, target: 15 });
    expect(parsePointerWordIndices("FF01")).toEqual({ source: 255, target: 1 });
  });

  it("rejects a malformed sourceTarget field", () => {
    for (const raw of ["", "00", "00000", "zz00", "01 2"]) {
      expect(parsePointerWordIndices(raw)).toBeNull();
    }
  });
});

describe("normalizeLemmaKey", () => {
  it("strips parentheticals, converts underscores to spaces, and lower-cases", () => {
    expect(normalizeLemmaKey("Dog")).toBe("dog");
    expect(normalizeLemmaKey("estimate(p)")).toBe("estimate");
  });

  it("returns null for a multi-word or empty lemma", () => {
    expect(normalizeLemmaKey("motor_vehicle")).toBeNull();
    expect(normalizeLemmaKey("New York")).toBeNull();
    expect(normalizeLemmaKey("(p)")).toBeNull();
    expect(normalizeLemmaKey("   ")).toBeNull();
  });
});

describe("lexicalRelationFacet + priority + cap", () => {
  it("reports the direction/source of every relation through behavior", () => {
    expect(lexicalRelationFacet("hypernym").direction).toBe("broader");
    expect(lexicalRelationFacet("hyponym").direction).toBe("narrower");
    expect(lexicalRelationFacet("inflection").source).toBe("morphology");
    expect(lexicalRelationFacet("synonym").source).toBe("synset");
    expect(lexicalRelationFacet("antonym").source).toBe("lexical");
    expect(lexicalRelationFacet("hypernym").source).toBe("semantic");
    for (const type of LEXICAL_RELATION_PRIORITY) {
      const facet = lexicalRelationFacet(type);
      const broader = type === "hypernym";
      const narrower = type === "hyponym";
      expect(facet.direction).toBe(broader ? "broader" : narrower ? "narrower" : "lateral");
    }
  });

  it("orders relations closest-first and caps per relation", () => {
    expect(LEXICAL_RELATION_PRIORITY).toEqual([
      "inflection",
      "synonym",
      "antonym",
      "derivation",
      "hypernym",
      "hyponym"
    ]);
    expect(MAX_NOTES_PER_RELATION).toBe(5);
  });
});

describe("classifyLexicalRelation", () => {
  const sets = new Map<LexicalRelationType, ReadonlySet<string>>([
    ["synonym", new Set(["auto"])],
    ["antonym", new Set(["cold"])],
    ["hypernym", new Set(["motor_vehicle_key", "vehicle"])],
    ["hyponym", new Set(["cab"])]
  ]);

  it("returns the highest-priority matching relation", () => {
    // Inflection wins over any set membership.
    expect(classifyLexicalRelation("auto", sets, true)).toBe("inflection");
    // A key present only in a set resolves to that set's relation.
    expect(classifyLexicalRelation("auto", sets, false)).toBe("synonym");
    expect(classifyLexicalRelation("cold", sets, false)).toBe("antonym");
    expect(classifyLexicalRelation("vehicle", sets, false)).toBe("hypernym");
    expect(classifyLexicalRelation("cab", sets, false)).toBe("hyponym");
  });

  it("prefers an earlier relation when a key is in several sets", () => {
    const overlap = new Map<LexicalRelationType, ReadonlySet<string>>([
      ["hypernym", new Set(["get"])],
      ["hyponym", new Set(["get"])]
    ]);
    expect(classifyLexicalRelation("get", overlap, false)).toBe("hypernym");
  });

  it("returns null for an unrelated key with no inflection", () => {
    expect(classifyLexicalRelation("banana", sets, false)).toBeNull();
    // An empty priority miss with inflection false still yields null.
    expect(classifyLexicalRelation("banana", new Map(), false)).toBeNull();
  });
});
