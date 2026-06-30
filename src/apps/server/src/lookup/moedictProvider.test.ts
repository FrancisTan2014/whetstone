import { describe, expect, it } from "vitest";

import { adaptMoedict, createMoedictProvider, moedictAttribution } from "./moedictProvider.js";
import type { HttpClient, HttpResult } from "./httpClient.js";

// Canned moedict JSON for 卿, trimmed to the fields the adapter reads — definitions carry the real
// `<a href>` / `<span class="punct">` markup and an entity so the stripping is exercised.
const cannedMoedict = {
  English: "high ranking official (old)",
  heteronyms: [
    {
      bopomofo: "ㄑㄧㄥ",
      definitions: [
        {
          def: '<a href="./#職官">職官</a><span class="punct">名。</span>古代位在大夫之上的官爵。',
          example: ['<span class="punct">如：「<a href="./#公卿">公卿</a>」。</span>'],
          type: '<a href="./#名">名</a>'
        },
        {
          def: "對人的尊稱。",
          quote: ["《史記》：「衛人謂之慶卿。」"],
          type: '<a href="./#名">名</a>'
        },
        { def: "君對臣的美稱 &amp; 愛稱。", type: '<a href="./#代">代</a>' }
      ],
      pinyin: "qīng"
    }
  ],
  title: "卿"
};

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

describe("adaptMoedict", () => {
  it("normalizes Chinese senses grouped by 詞性, with examples + citations and stripped markup", () => {
    expect(adaptMoedict(cannedMoedict, "卿")).toEqual({
      headword: "卿",
      partsOfSpeech: [
        {
          partOfSpeech: "名",
          senses: [
            {
              definition: "職官名。古代位在大夫之上的官爵。",
              examples: ["如：「公卿」。"],
              synonyms: []
            },
            {
              definition: "對人的尊稱。",
              examples: ["《史記》：「衛人謂之慶卿。」"],
              synonyms: []
            }
          ]
        },
        {
          partOfSpeech: "代",
          senses: [{ definition: "君對臣的美稱 & 愛稱。", examples: [], synonyms: [] }]
        }
      ],
      pronunciations: [{ ipa: "qīng ㄑㄧㄥ" }],
      sources: [moedictAttribution]
    });
  });

  it("strips <a href> cross-reference markup from a multi-character headword (#297)", () => {
    const entry = adaptMoedict(
      {
        heteronyms: [
          {
            bopomofo: "ㄖㄨˊ",
            definitions: [{ def: "研究儒家學術的人。", type: "名" }],
            pinyin: "rú zhě"
          }
        ],
        title: '<a href="./#儒">儒</a><a href="./#者">者</a>'
      },
      "儒者"
    );

    expect(entry?.headword).toBe("儒者");
  });

  it("skips definitions without a def field and ignores non-string examples", () => {
    const entry = adaptMoedict(
      {
        heteronyms: [
          {
            bopomofo: "ㄧ",
            definitions: [{ type: "名" }, { def: "解釋。", example: ["真例", 7, null], type: "名" }]
          }
        ]
      },
      "一"
    );

    expect(entry?.partsOfSpeech).toEqual([
      { partOfSpeech: "名", senses: [{ definition: "解釋。", examples: ["真例"], synonyms: [] }] }
    ]);
  });

  it("returns null when the payload is not a record", () => {
    expect(adaptMoedict("nope", "卿")).toBeNull();
  });

  it("returns null when no heteronym carries a usable definition", () => {
    expect(
      adaptMoedict(
        { heteronyms: [{ bopomofo: "ㄒ", definitions: [{ def: "", type: "名" }] }] },
        "x"
      )
    ).toBeNull();
  });

  it("falls back to the requested term as headword and groups untyped senses", () => {
    const entry = adaptMoedict({ heteronyms: [{ definitions: [{ def: "解釋。" }] }] }, "字");

    expect(entry?.headword).toBe("字");
    expect(entry?.pronunciations).toEqual([]);
    expect(entry?.partsOfSpeech).toEqual([
      { senses: [{ definition: "解釋。", examples: [], synonyms: [] }] }
    ]);
  });

  it("caps senses per 詞性 at six", () => {
    const definitions = Array.from({ length: 8 }, (_, index) => ({
      def: `釋義${index}`,
      type: "名"
    }));
    const entry = adaptMoedict({ heteronyms: [{ bopomofo: "ㄚ", definitions }] }, "多");

    expect(entry?.partsOfSpeech[0]?.senses).toHaveLength(6);
  });

  it("dedupes pronunciations across heteronyms", () => {
    const entry = adaptMoedict(
      {
        heteronyms: [
          { bopomofo: "ㄑ", definitions: [{ def: "一" }], pinyin: "qing" },
          { bopomofo: "ㄑ", definitions: [{ def: "二" }], pinyin: "qing" }
        ]
      },
      "卿"
    );

    expect(entry?.pronunciations).toEqual([{ ipa: "qing ㄑ" }]);
  });
});

describe("createMoedictProvider", () => {
  it("requests the moedict JSON endpoint for the term, time-bounded, and adapts the result", async () => {
    const http = fakeHttpClient({ ok: true, value: cannedMoedict });
    const provider = createMoedictProvider({ httpClient: http });

    const entry = await provider.lookup("卿");

    expect(http.lastUrl()).toBe("https://www.moedict.tw/%E5%8D%BF.json");
    expect(http.lastTimeoutMs()).toBe(2500);
    expect(entry?.headword).toBe("卿");
  });

  it("honors a custom timeout", async () => {
    const http = fakeHttpClient({ ok: true, value: cannedMoedict });
    const provider = createMoedictProvider({ httpClient: http, timeoutMs: 800 });

    await provider.lookup("卿");

    expect(http.lastTimeoutMs()).toBe(800);
  });

  it("resolves null on a transport/HTTP failure so CC-CEDICT remains the fallback", async () => {
    const http = fakeHttpClient({ error: { kind: "timeout" }, ok: false });
    const provider = createMoedictProvider({ httpClient: http });

    expect(await provider.lookup("卿")).toBeNull();
  });
});
