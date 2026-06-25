// The CC-CEDICT provider: a bundled Chinese-English dictionary normalized behind the shared
// DictionaryProvider seam. This file is PURE — it parses already-decompressed dictionary text
// and serves lookups from an in-memory index; file reading and gunzip live in the composition
// root so these functions stay fast and deterministic to test against sample text.

import type { DictionaryEntry } from "@whetstone/contracts";

// Attribution surfaced alongside Chinese results in the entry's `sources`.
// CC-CEDICT is licensed CC BY-SA 4.0 (see src/lookup/data/README.md).
export const cedictAttribution = "Definitions from CC-CEDICT (CC BY-SA 4.0).";

// A few concise senses keep the popover scannable.
const maxSenses = 5;

// One CC-CEDICT entry: both surface forms, the tone-numbered pinyin, and the English glosses.
export type CedictEntry = Readonly<{
  glosses: ReadonlyArray<string>;
  pinyin: string;
  simplified: string;
  traditional: string;
}>;

// Headword (Simplified or Traditional) -> the merged entry, so either surface form resolves.
// Lines that share a headword merge their glosses behind the first reading's pinyin.
export type CedictIndex = ReadonlyMap<string, CedictEntry>;

// Parse one entry line `Traditional Simplified [pin1 yin1] /gloss1/gloss2/`, returning the
// entry or undefined when the line is malformed. Index-based slicing (never regex groups)
// keeps each failure branch reachable from a crafted sample line.
function parseEntry(line: string): CedictEntry | undefined {
  const openBracket = line.indexOf("[");
  const closeBracket = line.indexOf("]", openBracket + 1);
  const firstSlash = line.indexOf("/", closeBracket + 1);

  if (openBracket < 1 || closeBracket < 0 || firstSlash < 0) {
    return undefined;
  }

  const headwords = line.slice(0, openBracket).trim();
  const spaceIndex = headwords.indexOf(" ");

  if (spaceIndex < 0) {
    return undefined;
  }

  const traditional = headwords.slice(0, spaceIndex);
  const simplified = headwords.slice(spaceIndex + 1).trim();
  const pinyin = line.slice(openBracket + 1, closeBracket).trim();
  const glosses = line
    .slice(firstSlash + 1)
    .split("/")
    .map((gloss) => gloss.trim())
    .filter((gloss) => gloss.length > 0);

  if (glosses.length === 0) {
    return undefined;
  }

  return { glosses, pinyin, simplified, traditional };
}

function addEntry(index: Map<string, CedictEntry>, headword: string, entry: CedictEntry): void {
  const existing = index.get(headword);

  if (existing === undefined) {
    index.set(headword, entry);
    return;
  }

  // A headword with several readings (e.g. 行) merges later glosses behind the first pinyin.
  index.set(headword, { ...existing, glosses: [...existing.glosses, ...entry.glosses] });
}

// Build the in-memory index from CC-CEDICT text: skip `#` comments and blanks, parse each
// entry line, and key it by BOTH the Simplified and Traditional headword.
export function parseCedict(text: string): CedictIndex {
  const index = new Map<string, CedictEntry>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const entry = parseEntry(line);

    if (entry === undefined) {
      continue;
    }

    addEntry(index, entry.simplified, entry);

    if (entry.traditional !== entry.simplified) {
      addEntry(index, entry.traditional, entry);
    }
  }

  return index;
}

// CC-CEDICT writes ü as `u:` (and Ü as `U:`); render it as the actual umlaut vowel.
function formatPinyin(pinyin: string): string {
  return pinyin.replace(/u:/g, "ü").replace(/U:/g, "Ü");
}

export interface CedictProvider {
  lookup(term: string): Promise<DictionaryEntry | null>;
}

// A pure provider over a prebuilt index: maps the matched entry into a DictionaryEntry (pinyin
// as the pronunciation, glosses as part-of-speech-less senses, CC-CEDICT attribution) or
// resolves null when the term is absent.
export function createCedictProvider(index: CedictIndex): CedictProvider {
  function lookup(term: string): Promise<DictionaryEntry | null> {
    const entry = index.get(term);

    if (entry === undefined) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      headword: term,
      partsOfSpeech: [
        {
          senses: entry.glosses
            .slice(0, maxSenses)
            .map((gloss) => ({ definition: gloss, examples: [], synonyms: [] }))
        }
      ],
      pronunciations: [{ ipa: formatPinyin(entry.pinyin) }],
      sources: [cedictAttribution]
    });
  }

  return Object.freeze({ lookup });
}
