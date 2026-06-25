import { describe, expect, it } from "vitest";

import { cedictAttribution, createCedictProvider, parseCedict } from "./cedict.js";

// Sample CC-CEDICT text: a leading comment, a blank line, well-formed entries (single and
// multi-sense, same and differing surface forms, a repeated headword with two readings, a
// `u:` umlaut, and an over-cap entry), and four kinds of malformed lines.
const sample = [
  "# CC-CEDICT sample header",
  "",
  "你好 你好 [ni3 hao3] /hello; hi/",
  "中國 中国 [Zhong1 guo2] /China/Middle Kingdom/",
  "行 行 [hang2] /row/line/",
  "行 行 [xing2] /to walk/to be OK/",
  "女 女 [nu:3] /woman/female/",
  "集 集 [ji2] /to gather/to collect/collection/anthology/to add up/edition/",
  "garbage line without structure",
  "你好 你好 [ni3 hao3 /broken bracket/",
  "你好 你好 [ni3 hao3] no slash here",
  "单[dan1] /single/",
  "你好 你好 [ni3 hao3] //"
].join("\n");

const index = parseCedict(sample);

describe("parseCedict", () => {
  it("indexes a single entry by its headword", () => {
    expect(index.get("你好")).toEqual({
      glosses: ["hello; hi"],
      pinyin: "ni3 hao3",
      simplified: "你好",
      traditional: "你好"
    });
  });

  it("keeps every gloss of a multi-sense entry", () => {
    expect(index.get("中国")?.glosses).toEqual(["China", "Middle Kingdom"]);
  });

  it("resolves a differing Traditional surface form to the same entry", () => {
    expect(index.get("中國")?.glosses).toEqual(["China", "Middle Kingdom"]);
  });

  it("merges the glosses of a headword that appears on multiple lines", () => {
    expect(index.get("行")).toEqual({
      glosses: ["row", "line", "to walk", "to be OK"],
      pinyin: "hang2",
      simplified: "行",
      traditional: "行"
    });
  });

  it("skips comment lines, blank lines, and malformed lines", () => {
    expect(index.get("garbage")).toBeUndefined();
    expect(index.has("#")).toBe(false);
    // The broken-bracket, no-slash, and empty-gloss lines never overwrite the valid 你好 entry.
    expect(index.get("你好")?.glosses).toEqual(["hello; hi"]);
  });

  it("ignores a headword line with only one surface form", () => {
    expect(index.get("单")).toBeUndefined();
  });
});

describe("createCedictProvider", () => {
  const provider = createCedictProvider(index);

  it("maps a match into a DictionaryEntry: pinyin pronunciation, glosses as senses, attribution", async () => {
    expect(await provider.lookup("你好")).toEqual({
      headword: "你好",
      partsOfSpeech: [{ senses: [{ definition: "hello; hi", examples: [], synonyms: [] }] }],
      pronunciations: [{ ipa: "ni3 hao3" }],
      sources: [cedictAttribution]
    });
  });

  it("uses the matched term as the headword for a Traditional surface form", async () => {
    expect(await provider.lookup("中國")).toEqual({
      headword: "中國",
      partsOfSpeech: [
        {
          senses: [
            { definition: "China", examples: [], synonyms: [] },
            { definition: "Middle Kingdom", examples: [], synonyms: [] }
          ]
        }
      ],
      pronunciations: [{ ipa: "Zhong1 guo2" }],
      sources: [cedictAttribution]
    });
  });

  it("caps the senses at five", async () => {
    const entry = await provider.lookup("集");

    expect(entry?.partsOfSpeech[0]?.senses).toEqual([
      { definition: "to gather", examples: [], synonyms: [] },
      { definition: "to collect", examples: [], synonyms: [] },
      { definition: "collection", examples: [], synonyms: [] },
      { definition: "anthology", examples: [], synonyms: [] },
      { definition: "to add up", examples: [], synonyms: [] }
    ]);
  });

  it("renders a `u:` umlaut as ü in the pronunciation", async () => {
    expect((await provider.lookup("女"))?.pronunciations).toEqual([{ ipa: "nü3" }]);
  });

  it("resolves null for a term that is not in the dictionary", async () => {
    expect(await provider.lookup("沒有這個詞")).toBeNull();
  });
});

describe("cedictAttribution", () => {
  it("credits CC-CEDICT under CC BY-SA 4.0", () => {
    expect(cedictAttribution).toBe("Definitions from CC-CEDICT (CC BY-SA 4.0).");
  });
});
