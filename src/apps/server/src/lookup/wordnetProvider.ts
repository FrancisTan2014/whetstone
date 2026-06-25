import type { DictionaryPartOfSpeech, DictionarySense } from "@whetstone/contracts";

import { asArray, asString } from "./jsonValue.js";

// WordNet is the offline backbone: a bundled, MIT-licensed database (via `wordpos` /
// `wordnet-db`) that guarantees English lookups resolve even when the community Free
// Dictionary host is down, and supplies the synonym sets (synsets).
export const wordNetSource =
  "Synonyms and fallback definitions from WordNet® 3.1, Princeton University (wordnet.princeton.edu).";

// A few senses per part of speech keep the popover scannable; common words (e.g. "set") have
// dozens of WordNet synsets.
const maxSensesPerPartOfSpeech = 6;

// The slice of one `wordpos.lookup` result we read. Typed loosely (the fields are untrusted at
// this boundary) and narrowed below; the real wordpos instance is injected so the provider is
// tested with fakes (no file or network access).
export type WordNetSynset = Readonly<{
  def?: unknown;
  exp?: unknown;
  pos?: unknown;
  synonyms?: unknown;
}>;

export interface WordPosLike {
  lookup(word: string): Promise<ReadonlyArray<WordNetSynset>>;
}

// What the composer consumes from WordNet: senses grouped by part of speech (each synset is a
// sense, with its definition, example sentences, and synonyms).
export type WordNetResult = Readonly<{
  partsOfSpeech: ReadonlyArray<DictionaryPartOfSpeech>;
}>;

export interface WordNetProvider {
  lookup(term: string): Promise<WordNetResult | null>;
}

// WordNet part-of-speech codes ('n' noun, 'v' verb, 'a'/'s' adjective + satellite, 'r' adverb)
// to readable labels matching the Wiktionary labels so synonyms compose across sources by part
// of speech.
function partOfSpeechLabel(pos: string): string | undefined {
  switch (pos) {
    case "n":
      return "noun";
    case "v":
      return "verb";
    case "a":
    case "s":
      return "adjective";
    case "r":
      return "adverb";
    default:
      return undefined;
  }
}

// WordNet lemmas use underscores for spaces and trailing markers like `(p)` (predicative);
// clean them into plain words.
function cleanLemma(lemma: string): string {
  return lemma
    .replace(/\(.*?\)/g, "")
    .replace(/_/g, " ")
    .trim();
}

// The synset's synonyms: cleaned lemmas, excluding the headword itself and empties, deduped.
function synonymsOf(synonyms: unknown, headword: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of asArray(synonyms)) {
    const lemma = asString(raw);

    if (lemma === undefined) {
      continue;
    }

    const cleaned = cleanLemma(lemma);
    const key = cleaned.toLowerCase();

    if (cleaned.length === 0 || key === headword.toLowerCase() || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

function examplesOf(exp: unknown): ReadonlyArray<string> {
  const examples: string[] = [];

  for (const item of asArray(exp)) {
    const example = asString(item);

    if (example !== undefined) {
      examples.push(example);
    }
  }

  return examples;
}

function senseOf(synset: WordNetSynset, headword: string): DictionarySense | undefined {
  const definition = asString(synset.def);

  if (definition === undefined) {
    return undefined;
  }

  return {
    definition,
    examples: [...examplesOf(synset.exp)],
    synonyms: [...synonymsOf(synset.synonyms, headword)]
  };
}

// Pure mapping: group WordNet synsets by part of speech (preserving first-seen order), each
// synset becoming a sense, capped per part of speech. Returns null when nothing is usable.
export function mapWordNetSynsets(
  synsets: ReadonlyArray<WordNetSynset>,
  headword: string
): WordNetResult | null {
  const order: DictionaryPartOfSpeech[] = [];
  const byLabel = new Map<string, DictionarySense[]>();

  for (const synset of synsets) {
    const pos = asString(synset.pos);
    const label = pos === undefined ? undefined : partOfSpeechLabel(pos);

    if (label === undefined) {
      continue;
    }

    const sense = senseOf(synset, headword);

    if (sense === undefined) {
      continue;
    }

    let senses = byLabel.get(label);

    if (senses === undefined) {
      senses = [];
      byLabel.set(label, senses);
      order.push({ partOfSpeech: label, senses });
    }

    if (senses.length < maxSensesPerPartOfSpeech) {
      senses.push(sense);
    }
  }

  return order.length === 0 ? null : { partsOfSpeech: order };
}

// Wrap an injected wordpos-like instance behind the provider seam. A lookup failure (the
// WordNet files being unreadable, say) resolves to null so English lookup degrades gracefully
// rather than throwing.
export function createWordNetProvider(wordpos: WordPosLike): WordNetProvider {
  async function lookup(term: string): Promise<WordNetResult | null> {
    try {
      const synsets = await wordpos.lookup(term);
      return mapWordNetSynsets(synsets, term);
    } catch {
      return null;
    }
  }

  return Object.freeze({ lookup });
}
