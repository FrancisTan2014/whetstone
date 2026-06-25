import type { DictionaryEntry, DictionaryPartOfSpeech } from "@whetstone/contracts";

import {
  wiktionarySource,
  type WiktionaryProvider,
  type WiktionaryResult
} from "./freeDictionaryProvider.js";
import { wordNetSource, type WordNetProvider, type WordNetResult } from "./wordnetProvider.js";

export type EnglishLookupDependencies = Readonly<{
  wiktionary: WiktionaryProvider;
  wordNet: WordNetProvider;
}>;

export interface EnglishLookupProvider {
  lookup(term: string): Promise<DictionaryEntry | null>;
}

// WordNet synonyms keyed by part-of-speech label, unioning every synset's synonyms for that
// label. This is the synonym backbone the composer merges into whichever source supplies the
// senses (composing by role and part of speech — never aligning individual senses).
function wordNetSynonymsByPartOfSpeech(
  wordNet: WordNetResult | null
): ReadonlyMap<string, ReadonlyArray<string>> {
  const byLabel = new Map<string, string[]>();

  if (wordNet === null) {
    return byLabel;
  }

  for (const part of wordNet.partsOfSpeech) {
    if (part.partOfSpeech === undefined) {
      continue;
    }

    const existing = byLabel.get(part.partOfSpeech) ?? [];
    const synonyms = part.senses.flatMap((sense) => sense.synonyms);
    byLabel.set(part.partOfSpeech, [...existing, ...synonyms]);
  }

  return byLabel;
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const key = value.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

// Merge the WordNet synonym backbone into the chosen senses by part-of-speech label, so every
// sense in a group carries that part of speech's synonyms (∪ the sense's own).
function withSynonyms(
  parts: ReadonlyArray<DictionaryPartOfSpeech>,
  synonymsByLabel: ReadonlyMap<string, ReadonlyArray<string>>
): ReadonlyArray<DictionaryPartOfSpeech> {
  return parts.map((part) => {
    const extra =
      part.partOfSpeech === undefined ? [] : (synonymsByLabel.get(part.partOfSpeech) ?? []);

    return {
      ...part,
      senses: part.senses.map((sense) => ({
        ...sense,
        synonyms: [...unique([...sense.synonyms, ...extra])]
      }))
    };
  });
}

// Compose an enriched DictionaryEntry by role: pronunciations and etymology from Wiktionary;
// senses grouped by part of speech from Wiktionary when it has them, else WordNet; synonyms
// from WordNet (∪ Wiktionary) merged in by part of speech. Returns null only when neither
// source yields any senses. `sources` credits every source that contributed.
export function composeEnglishEntry(
  headword: string,
  wiktionary: WiktionaryResult | null,
  wordNet: WordNetResult | null
): DictionaryEntry | null {
  const senseParts =
    wiktionary !== null && wiktionary.partsOfSpeech.length > 0
      ? wiktionary.partsOfSpeech
      : (wordNet?.partsOfSpeech ?? []);

  if (senseParts.length === 0) {
    return null;
  }

  const partsOfSpeech = withSynonyms(senseParts, wordNetSynonymsByPartOfSpeech(wordNet));
  const sources: string[] = [];

  if (wiktionary !== null) {
    sources.push(wiktionarySource);
  }

  if (wordNet !== null) {
    sources.push(wordNetSource);
  }

  return {
    headword,
    partsOfSpeech: [...partsOfSpeech],
    pronunciations: [...(wiktionary?.pronunciations ?? [])],
    sources,
    ...(wiktionary?.etymology === undefined ? {} : { etymology: wiktionary.etymology })
  };
}

// English lookup over both free sources: query Wiktionary and the offline WordNet in parallel,
// then compose. WordNet guarantees a result even when Wiktionary (the community host) is down.
export function createEnglishLookup(
  dependencies: EnglishLookupDependencies
): EnglishLookupProvider {
  async function lookup(term: string): Promise<DictionaryEntry | null> {
    const [wiktionary, wordNet] = await Promise.all([
      dependencies.wiktionary.lookup(term),
      dependencies.wordNet.lookup(term)
    ]);

    return composeEnglishEntry(term, wiktionary, wordNet);
  }

  return Object.freeze({ lookup });
}
