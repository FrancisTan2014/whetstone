import type { DictionaryEntry } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { createInMemoryLookupCache } from "./lookupCache.js";
import { createLookupService } from "./lookupService.js";
import type { HttpClient, HttpResult } from "./httpClient.js";
import {
  createZhWiktionaryProvider,
  parseZhWiktionary,
  stripWikiMarkup,
  zhWiktionarySource
} from "./zhWiktionaryProvider.js";

// A representative zh.Wiktionary page: a non-Chinese section before and after the 漢語 one (which must
// be ignored), an etymology subsection, two part-of-speech subsections with markup-laden `# ` defs (a
// `#:` example line that is not a definition, and a non-POS subsection whose `#` line must be
// ignored).
const sampleWikitext = [
  "{{also|x}}",
  "==英語==",
  "===Noun===",
  "# an English gloss",
  "",
  "==漢語==",
  "===詞源===",
  "{{lang|zh}}從[[古代漢語]]演變而來。<ref>來源</ref>",
  "",
  "===名詞===",
  "# {{lb|zh}}'''[[國家|国家]]'''的[[首都]]",
  "# 第二個[[意思]]",
  "#: 這是例句，不計入",
  "",
  "===動詞===",
  "# [[說話|说话]]",
  "",
  "===發音===",
  "# 這行不是定義",
  "",
  "==日語==",
  "===Noun===",
  "# a Japanese gloss"
].join("\n");

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
    lastTimeoutMs: () => requestedTimeoutMs,
    lastUrl: () => requestedUrl
  };
}

describe("stripWikiMarkup", () => {
  it("resolves links, drops emphasis/templates/refs/HTML, and collapses whitespace", () => {
    expect(stripWikiMarkup("'''[[國家|国家]]'''的''[[首都]]''")).toBe("国家的首都");
    expect(stripWikiMarkup("{{lb|zh}}核心{{gloss|core}}")).toBe("核心");
    expect(stripWikiMarkup("文本<ref name=a>來源</ref>之後<ref name=b />。")).toBe("文本之後。");
    expect(stripWikiMarkup("行一 <br/> 行二")).toBe("行一 行二");
    expect(stripWikiMarkup("外{{a|{{b}}}}層")).toBe("外層");
  });
});

describe("parseZhWiktionary", () => {
  it("groups the Chinese section's senses by part of speech with markup stripped, plus etymology", () => {
    expect(parseZhWiktionary(sampleWikitext, "京")).toEqual<DictionaryEntry>({
      etymology: "從古代漢語演變而來。",
      headword: "京",
      partsOfSpeech: [
        {
          partOfSpeech: "名詞",
          senses: [
            { definition: "国家的首都", examples: [], synonyms: [] },
            { definition: "第二個意思", examples: [], synonyms: [] }
          ]
        },
        {
          partOfSpeech: "動詞",
          senses: [{ definition: "说话", examples: [], synonyms: [] }]
        }
      ],
      pronunciations: [],
      sources: [zhWiktionarySource]
    });
  });

  it("returns null when the page has no Chinese section", () => {
    const wikitext = ["==英語==", "===Noun===", "# only English here"].join("\n");
    expect(parseZhWiktionary(wikitext, "foo")).toBeNull();
  });

  it("returns null when the Chinese section yields no senses", () => {
    const wikitext = ["==汉语==", "===發音===", "* {{cmn-pron}}"].join("\n");
    expect(parseZhWiktionary(wikitext, "无")).toBeNull();
  });

  it("reads the Chinese section when it is the last section (no following L2) and omits empty etymology", () => {
    const wikitext = ["==汉语==", "===名词===", "# 一個[[意思|意思]]"].join("\n");
    expect(parseZhWiktionary(wikitext, "义")).toEqual<DictionaryEntry>({
      headword: "义",
      partsOfSpeech: [
        { partOfSpeech: "名词", senses: [{ definition: "一個意思", examples: [], synonyms: [] }] }
      ],
      pronunciations: [],
      sources: [zhWiktionarySource]
    });
  });

  it("merges repeated part-of-speech subsections and skips definitions that strip to empty", () => {
    const wikitext = [
      "==漢語==",
      "===名詞===",
      "# 第一義",
      "# {{rfdef}}",
      "===名詞===",
      "# 第二義"
    ].join("\n");
    expect(parseZhWiktionary(wikitext, "重")?.partsOfSpeech).toEqual([
      {
        partOfSpeech: "名詞",
        senses: [
          { definition: "第一義", examples: [], synonyms: [] },
          { definition: "第二義", examples: [], synonyms: [] }
        ]
      }
    ]);
  });

  it("drops a part-of-speech subsection that collected no usable definitions", () => {
    const wikitext = [
      "==漢語==",
      "===名詞===",
      "#: 只有例句，沒有定義",
      "===動詞===",
      "# 一個動作"
    ].join("\n");
    expect(parseZhWiktionary(wikitext, "x")?.partsOfSpeech).toEqual([
      { partOfSpeech: "動詞", senses: [{ definition: "一個動作", examples: [], synonyms: [] }] }
    ]);
  });

  it("caps senses per part of speech at six", () => {
    const defs = Array.from({ length: 8 }, (_, index) => `# 釋義${index}`);
    const wikitext = ["==漢語==", "===動詞===", ...defs].join("\n");
    expect(parseZhWiktionary(wikitext, "多")?.partsOfSpeech[0]?.senses).toHaveLength(6);
  });
});

describe("createZhWiktionaryProvider", () => {
  it("requests the MediaWiki parse API for the term, time-bounded, and parses the wikitext", async () => {
    const http = fakeHttpClient({ ok: true, value: { parse: { wikitext: sampleWikitext } } });
    const provider = createZhWiktionaryProvider({ httpClient: http });

    const entry = await provider.lookup("京");

    expect(http.lastUrl()).toBe(
      "https://zh.wiktionary.org/w/api.php?action=parse&page=%E4%BA%AC&prop=wikitext&format=json&formatversion=2&redirects=1"
    );
    expect(http.lastTimeoutMs()).toBe(2500);
    expect(entry?.headword).toBe("京");
    expect(entry?.sources).toEqual([zhWiktionarySource]);
  });

  it("honors a custom timeout", async () => {
    const http = fakeHttpClient({ ok: true, value: { parse: { wikitext: sampleWikitext } } });
    const provider = createZhWiktionaryProvider({ httpClient: http, timeoutMs: 800 });

    await provider.lookup("京");

    expect(http.lastTimeoutMs()).toBe(800);
  });

  it("resolves null for a page with no wikitext (missing/empty page) so the tab shows the empty state", async () => {
    const http = fakeHttpClient({ ok: true, value: {} });
    const provider = createZhWiktionaryProvider({ httpClient: http });

    expect(await provider.lookup("缺")).toBeNull();
  });

  it("throws on a transport/HTTP failure so the lookup surfaces that tab's error", async () => {
    const http = fakeHttpClient({ error: { kind: "timeout" }, ok: false });
    const provider = createZhWiktionaryProvider({ httpClient: http });

    await expect(provider.lookup("京")).rejects.toThrow(/zh\.Wiktionary lookup failed/);
  });

  it("propagates that error through the lookup service so the route fails the tab, not the panel", async () => {
    const http = fakeHttpClient({ error: { kind: "network" }, ok: false });
    const provider = createZhWiktionaryProvider({ httpClient: http });
    const service = createLookupService({
      cache: createInMemoryLookupCache(),
      sources: [{ id: "zhwiktionary", languages: ["zh-CN", "zh-TW"], lookup: provider.lookup }]
    });

    await expect(service.lookup("京", "zh-CN", "zhwiktionary")).rejects.toThrow(/zh\.Wiktionary/);
  });
});
