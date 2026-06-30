import type {
  DictionaryEntry,
  DictionaryPartOfSpeech,
  DictionarySense
} from "@whetstone/contracts";

import type { HttpClient } from "./httpClient.js";
import { asString, field } from "./jsonValue.js";

// zh.Wiktionary (the Chinese Wiktionary) carries richer classical Chinese senses (古義), 詞源
// (etymology), and part-of-speech detail than 萌典 for many 文言文 headwords. It is surfaced as a
// second Chinese tab (#196 plumbing, #306 non-empty-tab fallback) via the MediaWiki action=parse
// API (CC BY-SA); definitions only, never scraped or embedded.
export const zhWiktionarySource = "Definitions from Chinese Wiktionary (CC BY-SA).";

// A few senses per part of speech keep the popover scannable, matching the EN Wiktionary template.
const maxSensesPerPartOfSpeech = 6;

// The L2 language headings that open the Chinese section: 漢語 (traditional) and 汉语 (simplified).
const chineseSectionHeadings: ReadonlySet<string> = new Set(["漢語", "汉语"]);

// The 詞源/etymology subsection headings (traditional + simplified variants).
const etymologyHeadings: ReadonlySet<string> = new Set(["詞源", "词源", "字源", "語源", "语源"]);

// The part-of-speech subsection headings whose `# ` list items are definitions. Curated for the
// constructions a Chinese (esp. 文言文) reader meets; both traditional and simplified forms are
// listed so either script's heading resolves to a part-of-speech label.
const partOfSpeechHeadings: ReadonlySet<string> = new Set([
  "名詞",
  "名词",
  "動詞",
  "动词",
  "形容詞",
  "形容词",
  "副詞",
  "副词",
  "代詞",
  "代词",
  "代名詞",
  "代名词",
  "數詞",
  "数词",
  "量詞",
  "量词",
  "助詞",
  "助词",
  "介詞",
  "介词",
  "連詞",
  "连词",
  "嘆詞",
  "叹词",
  "感嘆詞",
  "感叹词",
  "擬聲詞",
  "拟声词",
  "助動詞",
  "助动词",
  "專有名詞",
  "专有名词",
  "成語",
  "成语",
  "諺語",
  "谚语",
  "詞綴",
  "词缀",
  "前綴",
  "前缀",
  "後綴",
  "后缀",
  "方位詞",
  "方位词",
  "語氣詞",
  "语气词",
  "區別詞",
  "区别词",
  "字"
]);

type Heading = Readonly<{ level: number; text: string }>;

// A wiki heading line (`== L2 ==`, `=== L3 ===`, …): the run of leading equals sets the level and
// must close the line symmetrically. Anything else is body text.
function parseHeading(line: string): Heading | null {
  const match = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line.trim());

  if (match === null) {
    return null;
  }

  return { level: (match[1] as string).length, text: match[2] as string };
}

// Strip wiki markup to plain text: ref tags (with or without content), `{{…}}` templates (removed,
// innermost-first so nested templates flatten), `[[a|b]]`/`[[x]]` links to their display text,
// `'''`/`''` emphasis, any residual HTML tags, then collapsed whitespace. So a definition renders as
// clean Chinese instead of source markup.
export function stripWikiMarkup(text: string): string {
  let out = text.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>.*?<\/ref>/gi, "");

  let previous: string;
  do {
    previous = out;
    out = out.replace(/\{\{[^{}]*\}\}/g, "");
  } while (out !== previous);

  return out
    .replace(/\[\[[^[\]|]*\|([^[\]]*)\]\]/g, "$1")
    .replace(/\[\[([^[\]]*)\]\]/g, "$1")
    .replace(/'''/g, "")
    .replace(/''/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The lines of the Chinese (漢語/汉语) language section: from just after its L2 heading up to the next
// L2 heading (or end of page). Returns null when the page has no Chinese section, so the tab shows
// the empty/fallback state rather than mixing in another language's content.
function chineseSectionLines(wikitext: string): ReadonlyArray<string> | null {
  const lines = wikitext.split(/\r?\n/);
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index] as string);

    if (heading !== null && heading.level === 2 && chineseSectionHeadings.has(heading.text)) {
      start = index + 1;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  for (let index = start; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index] as string);

    if (heading !== null && heading.level === 2) {
      return lines.slice(start, index);
    }
  }

  return lines.slice(start);
}

// Pure parser: from raw zh.Wiktionary page wikitext, extract the Chinese section's senses grouped by
// part of speech (each POS subsection's `# ` items, markup stripped, capped) plus an optional 詞源
// etymology. Returns null when there is no Chinese section or it yields no senses, so the tab falls
// back per #306. The headword is the requested term (the page title equals it for a found page).
export function parseZhWiktionary(wikitext: string, term: string): DictionaryEntry | null {
  const lines = chineseSectionLines(wikitext);

  if (lines === null) {
    return null;
  }

  const byPartOfSpeech = new Map<string, DictionarySense[]>();
  const order: string[] = [];
  const etymologyLines: string[] = [];
  let currentPartOfSpeech: string | null = null;
  let inEtymology = false;

  for (const line of lines) {
    const heading = parseHeading(line);

    if (heading !== null) {
      if (partOfSpeechHeadings.has(heading.text)) {
        currentPartOfSpeech = heading.text;
        inEtymology = false;

        if (!byPartOfSpeech.has(currentPartOfSpeech)) {
          byPartOfSpeech.set(currentPartOfSpeech, []);
          order.push(currentPartOfSpeech);
        }
      } else {
        currentPartOfSpeech = null;
        inEtymology = etymologyHeadings.has(heading.text);
      }

      continue;
    }

    if (currentPartOfSpeech !== null) {
      const match = /^#\s+(.+)$/.exec(line.trim());

      if (match === null) {
        continue;
      }

      const senses = byPartOfSpeech.get(currentPartOfSpeech) as DictionarySense[];
      const definition = stripWikiMarkup(match[1] as string);

      if (definition.length === 0 || senses.length >= maxSensesPerPartOfSpeech) {
        continue;
      }

      senses.push({ definition, examples: [], synonyms: [] });
    } else if (inEtymology) {
      const text = stripWikiMarkup(line);

      if (text.length > 0) {
        etymologyLines.push(text);
      }
    }
  }

  const partsOfSpeech: DictionaryPartOfSpeech[] = [];

  for (const partOfSpeech of order) {
    const senses = byPartOfSpeech.get(partOfSpeech) as DictionarySense[];

    if (senses.length > 0) {
      partsOfSpeech.push({ partOfSpeech, senses });
    }
  }

  if (partsOfSpeech.length === 0) {
    return null;
  }

  const etymology = etymologyLines.join(" ");

  return {
    headword: term,
    partsOfSpeech,
    pronunciations: [],
    sources: [zhWiktionarySource],
    ...(etymology.length === 0 ? {} : { etymology })
  };
}

export type ZhWiktionaryProviderDependencies = Readonly<{
  httpClient: HttpClient;
  timeoutMs?: number;
}>;

export interface ZhWiktionaryProvider {
  lookup(term: string): Promise<DictionaryEntry | null>;
}

// zh.Wiktionary is a networked MediaWiki host; a lookup must never wait on it indefinitely. Bounding
// the request lets an unreachable/slow host fail fast into the tab's error state instead of leaving
// the Chinese tab stuck on "Looking up…".
const defaultLookupTimeoutMs = 2500;

// The MediaWiki action=parse API returning the page's raw wikitext (formatversion=2 yields the
// wikitext as a plain string; redirects=1 follows a redirect to the canonical entry). Outbound API
// only — no HTML scraping.
function buildUrl(term: string): string {
  return `https://zh.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(
    term
  )}&prop=wikitext&format=json&formatversion=2&redirects=1`;
}

function wikitextOf(payload: unknown): string {
  return asString(field(field(payload, "parse"), "wikitext")) ?? "";
}

// The zh.Wiktionary provider over the open MediaWiki API (no key). A no-Chinese-section/no-sense page
// resolves to null so the tab shows the empty/fallback state, but a transport/HTTP/timeout/parse
// failure is thrown so the lookup service surfaces that tab's error only (mirroring #196 isolation),
// never silently emptying it. The request is always time-bounded so an unreachable host cannot hang.
export function createZhWiktionaryProvider(
  dependencies: ZhWiktionaryProviderDependencies
): ZhWiktionaryProvider {
  const timeoutMs = dependencies.timeoutMs ?? defaultLookupTimeoutMs;

  async function lookup(term: string): Promise<DictionaryEntry | null> {
    const result = await dependencies.httpClient.getJson<unknown>(buildUrl(term), { timeoutMs });

    if (!result.ok) {
      throw new Error(`zh.Wiktionary lookup failed (${result.error.kind}).`);
    }

    return parseZhWiktionary(wikitextOf(result.value), term);
  }

  return Object.freeze({ lookup });
}
