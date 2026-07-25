import {
  classifyLexicalRelation,
  classifyWordNetPointer,
  lexicalPosCode,
  lexicalPosFromCode,
  normalizeLemmaKey,
  parsePointerWordIndices,
  type LexicalPartOfSpeech,
  type LexicalRelationType
} from "@whetstone/domain";

import { asArray, asString, isRecord } from "../../lookup/jsonValue.js";
import type { LexicalLemmatizer } from "./lexicalLemmatizer.js";

// The offline WordNet traversal for typed lexical relationships (#715). This module is the read-only bridge
// between the pure typing rules in `@whetstone/domain` and the WordNet database: it loads the senses of a
// surface (never choosing one), and — given ONE caller-selected sense — walks exactly one hop of the
// morphology/synonym/antonym/derivation/hypernym/hyponym relations, preserving direction and lexical-vs-
// semantic source. It writes nothing and resolves no duplicate/mastery decision.

// The narrow slice of one WordNet synset the service reads, already narrowed from the untrusted `wordpos`
// records. A pointer keeps its symbol, its target synset offset/pos, and the four-hex source/target word
// indices that distinguish a lexical (word-to-word) pointer from a semantic (synset) one.
export type LexicalRawPointer = Readonly<{
  symbol: string;
  synsetOffset: string;
  pos: string;
  sourceTarget: string;
}>;

export type LexicalRawSynset = Readonly<{
  synsetOffset: string;
  pos: string;
  synonyms: readonly string[];
  definition: string;
  examples: readonly string[];
  pointers: readonly LexicalRawPointer[];
}>;

// The injected WordNet seam: `lookup` resolves the synsets whose index entry matches a surface; `seek`
// resolves one synset by offset + POS letter (following a pointer to its target). A `seek` that cannot
// narrow a record returns null so a missing/malformed pointer target is skipped, never followed blindly. A
// genuine file failure rejects, which the service maps to the `unavailable` outcome. Injected so the whole
// service is tested with an in-memory fake and, separately, against the real database.
export interface LexicalWordNet {
  lookup(surface: string): Promise<readonly LexicalRawSynset[]>;
  seek(offset: string, pos: string): Promise<LexicalRawSynset | null>;
}

// One WordNet sense offered to the caller for explicit selection. The provider NEVER picks first/frequent;
// it returns every deduped sense with its stable identity (offset + POS), gloss, examples, and single-word
// synonym keys, so the next issue's UI owns the choice.
export type LexicalSense = Readonly<{
  offset: string;
  partOfSpeech: LexicalPartOfSpeech;
  definition: string;
  examples: readonly string[];
  lemmas: readonly string[];
}>;

// A selected sense to relate from: its synset offset and the part of speech under which it was chosen.
export type LexicalSenseRef = Readonly<{ offset: string; partOfSpeech: LexicalPartOfSpeech }>;

// The resolved one-hop neighborhood of a selected sense: the queried surface key, the specific synset lemma
// the surface maps to, its POS, and the per-relation sets of single-word target keys. Inflection is not a
// set (it needs the lemmatizer at match time), so it is decided in `classifyContextRelation`.
export type SenseRelationContext = Readonly<{
  surfaceKey: string;
  selectedLemma: string;
  partOfSpeech: LexicalPartOfSpeech;
  relationSets: ReadonlyMap<LexicalRelationType, ReadonlySet<string>>;
}>;

// The untyped `wordpos` instance shape this module needs. The real instance satisfies it; the ambient
// declaration types the return records loosely because the WordNet files are untrusted at this boundary.
export interface WordPosSeekLike {
  lookup(word: string): Promise<ReadonlyArray<unknown>>;
  seek(offset: string, pos: string): Promise<unknown>;
}

function stringArray(value: unknown): string[] {
  const result: string[] = [];
  for (const item of asArray(value)) {
    const text = asString(item);
    if (text !== undefined) {
      result.push(text);
    }
  }
  return result;
}

function narrowPointer(value: unknown): LexicalRawPointer | null {
  if (!isRecord(value)) {
    return null;
  }
  const symbol = asString((value as { pointerSymbol?: unknown }).pointerSymbol);
  const synsetOffset = asString((value as { synsetOffset?: unknown }).synsetOffset);
  const pos = asString((value as { pos?: unknown }).pos);
  const sourceTarget = asString((value as { sourceTarget?: unknown }).sourceTarget);
  if (
    symbol === undefined ||
    synsetOffset === undefined ||
    pos === undefined ||
    sourceTarget === undefined
  ) {
    return null;
  }
  return { symbol, synsetOffset, pos, sourceTarget };
}

function narrowSynset(value: unknown): LexicalRawSynset | null {
  if (!isRecord(value)) {
    return null;
  }
  const synsetOffset = asString((value as { synsetOffset?: unknown }).synsetOffset);
  const pos = asString((value as { pos?: unknown }).pos);
  if (synsetOffset === undefined || pos === undefined) {
    return null;
  }
  return {
    synsetOffset,
    pos,
    synonyms: stringArray((value as { synonyms?: unknown }).synonyms),
    definition: asString((value as { def?: unknown }).def) ?? "",
    examples: stringArray((value as { exp?: unknown }).exp),
    pointers: asArray((value as { ptrs?: unknown }).ptrs)
      .map(narrowPointer)
      .filter((pointer): pointer is LexicalRawPointer => pointer !== null)
  };
}

// Wrap the untyped `wordpos` instance behind the typed WordNet seam, narrowing every record defensively. A
// `seek` whose record cannot be narrowed resolves to null (skip the pointer); a rejected lookup/seek (an
// unreadable database) propagates so the service can report `unavailable`.
export function createWordNetLexical(wordpos: WordPosSeekLike): LexicalWordNet {
  async function lookup(surface: string): Promise<readonly LexicalRawSynset[]> {
    const raw = await wordpos.lookup(surface);
    return raw.map(narrowSynset).filter((synset): synset is LexicalRawSynset => synset !== null);
  }

  async function seek(offset: string, pos: string): Promise<LexicalRawSynset | null> {
    return narrowSynset(await wordpos.seek(offset, pos));
  }

  return Object.freeze({ lookup, seek });
}

function dedupeKeys(rawLemmas: readonly string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of rawLemmas) {
    const key = normalizeLemmaKey(raw);
    if (key !== null && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

// Load every deduped sense of a surface across the direct surface plus the noun/verb/adjective lemma
// candidates (adverbs resolve by surface). Senses are keyed by POS + offset so a lemma that resurfaces the
// same synset is not double-counted; insertion order is stable and deterministic. Returns the choices only —
// never a selection.
export async function collectLexicalSenses(
  wordnet: LexicalWordNet,
  surfaceKey: string,
  lemmatize: LexicalLemmatizer
): Promise<LexicalSense[]> {
  const byId = new Map<string, LexicalSense>();

  async function addFrom(query: string, restrict?: LexicalPartOfSpeech): Promise<void> {
    if (query.length === 0) {
      return;
    }
    for (const synset of await wordnet.lookup(query)) {
      const partOfSpeech = lexicalPosFromCode(synset.pos);
      if (partOfSpeech === null) {
        continue;
      }
      if (restrict !== undefined && partOfSpeech !== restrict) {
        continue;
      }
      const id = `${partOfSpeech}:${synset.synsetOffset}`;
      if (byId.has(id)) {
        continue;
      }
      byId.set(id, {
        offset: synset.synsetOffset,
        partOfSpeech,
        definition: synset.definition,
        examples: synset.examples,
        lemmas: dedupeKeys(synset.synonyms)
      });
    }
  }

  await addFrom(surfaceKey);
  await addFrom(lemmatize(surfaceKey, "noun"), "noun");
  await addFrom(lemmatize(surfaceKey, "verb"), "verb");
  await addFrom(lemmatize(surfaceKey, "adjective"), "adjective");

  return [...byId.values()];
}

function targetLemmaAt(target: LexicalRawSynset, index: number): string | null {
  const raw =
    index >= 1 && index <= target.synonyms.length ? target.synonyms[index - 1] : undefined;
  return raw === undefined ? null : normalizeLemmaKey(raw);
}

// Resolve the one-hop relation neighborhood of a selected sense, or null when the sense does not exist or the
// surface does not belong to it (a mismatched offset/POS). Same-synset synonyms come straight from the sense;
// lexical pointers (`!` antonym, `+` derivation) are followed ONLY from the selected word and resolve the
// specific target word; semantic pointers (`@` hypernym, `~` hyponym) contribute every lemma of the direct
// target synset. Malformed indices, unknown pointers, and missing targets are skipped in silence.
export async function resolveSenseRelations(
  wordnet: LexicalWordNet,
  surfaceKey: string,
  senseRef: LexicalSenseRef,
  lemmatize: LexicalLemmatizer
): Promise<SenseRelationContext | null> {
  const synset = await wordnet.seek(senseRef.offset, lexicalPosCode(senseRef.partOfSpeech));
  if (synset === null) {
    return null;
  }

  const candidateLemmas = new Set([surfaceKey, lemmatize(surfaceKey, senseRef.partOfSpeech)]);
  let selectedIndex = -1;
  let selectedLemma = "";
  synset.synonyms.forEach((raw, position) => {
    const key = normalizeLemmaKey(raw);
    if (key !== null && selectedIndex === -1 && candidateLemmas.has(key)) {
      selectedIndex = position + 1;
      selectedLemma = key;
    }
  });
  if (selectedIndex === -1) {
    return null;
  }

  const sets = new Map<LexicalRelationType, Set<string>>();
  const add = (type: LexicalRelationType, key: string): void => {
    let bucket = sets.get(type);
    if (bucket === undefined) {
      bucket = new Set<string>();
      sets.set(type, bucket);
    }
    bucket.add(key);
  };

  for (const raw of synset.synonyms) {
    const key = normalizeLemmaKey(raw);
    if (key !== null && key !== selectedLemma) {
      add("synonym", key);
    }
  }

  for (const pointer of synset.pointers) {
    const relation = classifyWordNetPointer(pointer.symbol);
    if (relation === null) {
      continue;
    }
    const indices = parsePointerWordIndices(pointer.sourceTarget);
    if (indices === null) {
      continue;
    }
    if (relation.facet.source === "lexical") {
      if (indices.source !== selectedIndex) {
        continue;
      }
      const target = await wordnet.seek(pointer.synsetOffset, pointer.pos);
      if (target === null) {
        continue;
      }
      const key = targetLemmaAt(target, indices.target);
      if (key !== null) {
        add(relation.type, key);
      }
    } else {
      const target = await wordnet.seek(pointer.synsetOffset, pointer.pos);
      if (target === null) {
        continue;
      }
      for (const rawTarget of target.synonyms) {
        const key = normalizeLemmaKey(rawTarget);
        if (key !== null) {
          add(relation.type, key);
        }
      }
    }
  }

  return {
    surfaceKey,
    selectedLemma,
    partOfSpeech: senseRef.partOfSpeech,
    relationSets: sets
  };
}

// Type the one-hop relation from a resolved sense to one existing single-word surface, or null for none. The
// queried surface itself (exact material) is excluded; an inflectional form is decided by lemmatizing the
// existing surface under the selected POS and comparing to the selected lemma; the rest is pure set
// membership resolved in priority order.
export function classifyContextRelation(
  context: SenseRelationContext,
  existingKey: string,
  lemmatize: LexicalLemmatizer
): LexicalRelationType | null {
  if (existingKey === context.surfaceKey) {
    return null;
  }
  const isInflection = lemmatize(existingKey, context.partOfSpeech) === context.selectedLemma;
  return classifyLexicalRelation(existingKey, context.relationSets, isInflection);
}
