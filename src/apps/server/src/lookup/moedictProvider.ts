import type {
  DictionaryEntry,
  DictionaryPartOfSpeech,
  DictionaryPronunciation,
  DictionarySense
} from "@whetstone/contracts";

import type { HttpClient } from "./httpClient.js";
import { asArray, asString, field, isRecord } from "./jsonValue.js";

// 萌典 (moedict) serves the Ministry of Education Chinese dictionaries over an open JSON API: Chinese
// 釋義 (definitions), 詞性 (part of speech), 例句/書證 (examples + literary citations), and 注音/拼音.
// Surfaced so a Chinese reader of 文言文 gets Chinese definitions, not CC-CEDICT's English glosses
// (#272). Definitions only — no 典故/allusion resolution (that is capture/recall's job, not lookup).
export const moedictAttribution =
  "釋義來自教育部《重編國語辭典修訂本》，由萌典 (moedict) 提供（CC BY-ND 3.0 臺灣）。";

// A few senses per part of speech keep the popover scannable.
const maxSensesPerType = 6;

// moedict definition text is HTML: `<a href>` cross-links between headwords and `<span class="punct">`
// punctuation wrappers. Strip the tags to plain text and decode the handful of entities the source
// emits, so the reader shows clean Chinese instead of markup.
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// One pronunciation per heteronym: pinyin (romanized) joined with 注音符號 (bopomofo) when present,
// deduped. moedict keeps multiple readings (e.g. 卿 vs polyphones) as separate heteronyms.
function pronunciationsOf(
  heteronyms: ReadonlyArray<unknown>
): ReadonlyArray<DictionaryPronunciation> {
  const seen = new Set<string>();
  const pronunciations: DictionaryPronunciation[] = [];

  for (const heteronym of heteronyms) {
    const parts = [asString(field(heteronym, "pinyin")), asString(field(heteronym, "bopomofo"))]
      .map((value) => value?.trim())
      .filter((value): value is string => value !== undefined && value.length > 0);
    const ipa = parts.join(" ");

    if (ipa.length === 0 || seen.has(ipa)) {
      continue;
    }

    seen.add(ipa);
    pronunciations.push({ ipa });
  }

  return pronunciations;
}

// Group every heteronym's definitions by 詞性 (part of speech), preserving first-seen order. Each
// definition's `example` and `quote` (書證, the classical citations that matter for 文言文) become the
// sense's examples; CC-CEDICT-style synonyms do not apply, so they stay empty.
function partsOfSpeechOf(
  heteronyms: ReadonlyArray<unknown>
): ReadonlyArray<DictionaryPartOfSpeech> {
  const byType = new Map<string, DictionarySense[]>();
  const order: string[] = [];

  for (const heteronym of heteronyms) {
    for (const definition of asArray(field(heteronym, "definitions"))) {
      const gloss = plainText(asString(field(definition, "def")) ?? "");

      if (gloss.length === 0) {
        continue;
      }

      const type = plainText(asString(field(definition, "type")) ?? "");
      const examples = [
        ...asArray(field(definition, "example")),
        ...asArray(field(definition, "quote"))
      ]
        .map((raw) => plainText(asString(raw) ?? ""))
        .filter((example) => example.length > 0);

      let senses = byType.get(type);

      if (senses === undefined) {
        senses = [];
        byType.set(type, senses);
        order.push(type);
      }

      if (senses.length >= maxSensesPerType) {
        continue;
      }

      senses.push({ definition: gloss, examples, synonyms: [] });
    }
  }

  return order.map((type) => {
    const senses = byType.get(type) as DictionarySense[];
    return type.length === 0 ? { senses } : { partOfSpeech: type, senses };
  });
}

// Pure adapter: normalize the moedict JSON shape into a DictionaryEntry, or null when there is no
// usable Chinese definition (not a record, or no heteronym carries a definition) so the CC-CEDICT
// fallback tab can still serve the word.
export function adaptMoedict(payload: unknown, term: string): DictionaryEntry | null {
  if (!isRecord(payload)) {
    return null;
  }

  const heteronyms = asArray(field(payload, "heteronyms"));
  const partsOfSpeech = partsOfSpeechOf(heteronyms);

  if (partsOfSpeech.length === 0) {
    return null;
  }

  // moedict's `title` carries the same `<a href="./#…">` cross-reference anchors as its definitions
  // for multi-character headwords (e.g. 儒者 -> `<a href="./#儒">儒</a><a href="./#者">者</a>`), so it
  // is stripped to plain text here exactly like every other field — never rendered raw (#297).
  const headword = plainText(asString(field(payload, "title")) ?? term);

  return {
    headword,
    partsOfSpeech: [...partsOfSpeech],
    pronunciations: [...pronunciationsOf(heteronyms)],
    sources: [moedictAttribution]
  };
}

export type MoedictProviderDependencies = Readonly<{
  httpClient: HttpClient;
  timeoutMs?: number;
}>;

export interface MoedictProvider {
  lookup(term: string): Promise<DictionaryEntry | null>;
}

// moedict is a community-hosted service over the network; a lookup must never wait on it
// indefinitely. Bounding the request lets an unreachable/slow host fail fast and fall back to the
// CC-CEDICT tab, instead of leaving the Chinese tab stuck on "Looking up…".
const defaultLookupTimeoutMs = 2500;

function buildUrl(term: string): string {
  return `https://www.moedict.tw/${encodeURIComponent(term)}.json`;
}

// The 萌典 provider over the open moedict JSON API (no key). Resolves to null on any transport/HTTP
// error, timeout, or no-match so the lookup service reports not-found and the reader's CC-CEDICT tab
// remains as the fallback. The request is always time-bounded so an unreachable host can never hang
// the Chinese lookup.
export function createMoedictProvider(dependencies: MoedictProviderDependencies): MoedictProvider {
  const timeoutMs = dependencies.timeoutMs ?? defaultLookupTimeoutMs;

  async function lookup(term: string): Promise<DictionaryEntry | null> {
    const result = await dependencies.httpClient.getJson<unknown>(buildUrl(term), { timeoutMs });

    if (!result.ok) {
      return null;
    }

    return adaptMoedict(result.value, term);
  }

  return Object.freeze({ lookup });
}
