import type { DictionaryEntry } from "@whetstone/contracts";

import {
  wiktionarySource,
  type WiktionaryProvider,
  type WiktionaryResult
} from "./freeDictionaryProvider.js";
import { wordNetSource, type WordNetProvider, type WordNetResult } from "./wordnetProvider.js";

// English lookup exposes WordNet and Wiktionary as two independent sources (tabs), each composing a
// stand-alone DictionaryEntry. They are never merged: WordNet resolves instantly offline; Wiktionary
// is networked and time-boxed, so a slow/down host fails its own tab and never freezes the popover
// (#196). Each entry's `sources` carries its single attribution.

export function composeWordNetEntry(
  headword: string,
  wordNet: WordNetResult | null
): DictionaryEntry | null {
  if (wordNet === null || wordNet.partsOfSpeech.length === 0) {
    return null;
  }

  return {
    headword,
    partsOfSpeech: [...wordNet.partsOfSpeech],
    pronunciations: [],
    sources: [wordNetSource]
  };
}

export function composeWiktionaryEntry(
  headword: string,
  wiktionary: WiktionaryResult | null
): DictionaryEntry | null {
  if (wiktionary === null || wiktionary.partsOfSpeech.length === 0) {
    return null;
  }

  return {
    headword,
    partsOfSpeech: [...wiktionary.partsOfSpeech],
    pronunciations: [...wiktionary.pronunciations],
    sources: [wiktionarySource],
    ...(wiktionary.etymology === undefined ? {} : { etymology: wiktionary.etymology })
  };
}

export function createWordNetEntryLookup(
  wordNet: WordNetProvider
): (term: string) => Promise<DictionaryEntry | null> {
  return async (term) => composeWordNetEntry(term, await wordNet.lookup(term));
}

export function createWiktionaryEntryLookup(
  wiktionary: WiktionaryProvider
): (term: string) => Promise<DictionaryEntry | null> {
  return async (term) => composeWiktionaryEntry(term, await wiktionary.lookup(term));
}
