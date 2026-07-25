// Pure, deterministic building blocks for offline English lexical relationships (#715). This module holds
// only string/normalization/classification logic — no WordNet file access, no lemmatizer, no database. The
// server's lexical feature composes these helpers over the injected WordNet provider and note reader so the
// risky boundary logic (eligibility, pointer typing, relation priority) is unit-tested without Node APIs.
//
// A lexical relationship and a duplicate-identity decision are DIFFERENT facts: this layer only types a
// one-hop morphology/WordNet relation between two surfaces. It never picks a sense, writes an edge, or feeds
// mastery. Silence wins — an ineligible surface or an unrecognized pointer yields nothing rather than a guess.

// The four open English parts of speech WordNet distinguishes. Adjective covers WordNet's head adjective
// (`a`) and satellite (`s`); adverb (`r`) is looked up by surface only (no lemmatizer generates adverbs).
export type LexicalPartOfSpeech = "noun" | "verb" | "adjective" | "adverb";

// The typed one-hop relations this foundation reports. Deliberately narrow: morphological inflection, the
// selected synset's own synonyms, and only the lexical antonym/derivation and direct semantic hypernym/
// hyponym pointers. Meronymy/holonymy, entailment, cause, also-see, attribute, similar-to, pertainym,
// domain, verb-group and participle pointers are intentionally excluded (see `classifyWordNetPointer`).
export type LexicalRelationType =
  | "inflection"
  | "synonym"
  | "antonym"
  | "derivation"
  | "hypernym"
  | "hyponym";

// Direction preserves the asymmetry of a relation: a hypernym is broader, a hyponym is narrower, everything
// else is lateral. The next issue's UI reads this to label "broader/narrower" without re-deriving it.
export type LexicalRelationDirection = "lateral" | "broader" | "narrower";

// The evidence source of a relation, so lexical (word-to-word) facts are never conflated with semantic
// (synset-to-synset) ones: morphology (inflection), synset (co-membership synonyms), lexical (word-level
// antonym/derivation pointers), semantic (synset-level hypernym/hyponym pointers).
export type LexicalRelationSource = "morphology" | "synset" | "lexical" | "semantic";

// The fixed order relations are reported and, per relation, notes are capped. Inflection first (closest to
// the same word), then same-synset synonyms, then the lexical then the semantic pointer relations. A surface
// that qualifies for several relations is attributed to the highest-priority one exactly once.
export const LEXICAL_RELATION_PRIORITY: readonly LexicalRelationType[] = [
  "inflection",
  "synonym",
  "antonym",
  "derivation",
  "hypernym",
  "hyponym"
];

// At most five owned notes per relation keep the surfaced set scannable; the pure ranking below trims each
// relation to this cap in stable id order.
export const MAX_NOTES_PER_RELATION = 5;

// A relation's fixed direction and source. Kept beside the type union so a consumer can render a relation
// without a second lookup table; asserted through behavior (a hypernym group is broader/semantic), never a
// test that merely restates the constant.
export type LexicalRelationFacet = Readonly<{
  direction: LexicalRelationDirection;
  source: LexicalRelationSource;
}>;

const RELATION_FACETS: Readonly<Record<LexicalRelationType, LexicalRelationFacet>> = {
  inflection: { direction: "lateral", source: "morphology" },
  synonym: { direction: "lateral", source: "synset" },
  antonym: { direction: "lateral", source: "lexical" },
  derivation: { direction: "lateral", source: "lexical" },
  hypernym: { direction: "broader", source: "semantic" },
  hyponym: { direction: "narrower", source: "semantic" }
};

export function lexicalRelationFacet(type: LexicalRelationType): LexicalRelationFacet {
  return RELATION_FACETS[type];
}

// An eligible lexical surface is exactly one ASCII English word, optionally joined by internal apostrophes or
// hyphens (e.g. `don't`, `well-known`). Everything else — a phrase (spaces), a number, punctuation like
// `C++`, an emoji, or any non-ASCII script (CJK, Cyrillic, mixed) — is UNSUPPORTED and normalizes to null so
// the service stays silent instead of guessing. Case is folded and the string NFC-normalized first; the
// lowercase form is the stable lemma key used to compare surfaces and match owned notes.
const ELIGIBLE_SURFACE = /^[a-z]+(?:['-][a-z]+)*$/u;

export function normalizeLexicalSurface(raw: string): string | null {
  const folded = raw.normalize("NFC").trim().toLowerCase();
  return ELIGIBLE_SURFACE.test(folded) ? folded : null;
}

// The WordNet part-of-speech letter for each open class, used to seek the data file for a selected sense.
// Adjective seeks the shared adjective file (`a` also serves satellites), adverb the adverb file.
const POS_CODE: Readonly<Record<LexicalPartOfSpeech, string>> = {
  noun: "n",
  verb: "v",
  adjective: "a",
  adverb: "r"
};

export function lexicalPosCode(pos: LexicalPartOfSpeech): string {
  return POS_CODE[pos];
}

// Map a raw WordNet POS code onto our label, or null for an unknown code. Adjective satellites (`s`) fold
// into adjective so a satellite sense composes with head-adjective synonyms.
export function lexicalPosFromCode(code: string): LexicalPartOfSpeech | null {
  switch (code) {
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
      return null;
  }
}

// The typed relation a single WordNet pointer symbol contributes, or null when the pointer is deliberately
// NOT traversed. Included: `!` antonym (lexical), `+` derivationally related form (lexical), `@`/`@i`
// hypernym (semantic, broader), `~`/`~i` hyponym (semantic, narrower). Everything else — meronym `%`,
// holonym `#`, entailment `*`, cause `>`, also-see `^`, attribute `=`, similar-to `&`, pertainym `\`,
// domain `;`/`-`, verb group `$`, participle `<` — is excluded so morphology, antonymy and taxonomy never
// leak meronymy or multi-hop noise.
export type WordNetPointerRelation = Readonly<{
  type: Exclude<LexicalRelationType, "inflection" | "synonym">;
  facet: LexicalRelationFacet;
}>;

export function classifyWordNetPointer(symbol: string): WordNetPointerRelation | null {
  switch (symbol) {
    case "!":
      return { type: "antonym", facet: RELATION_FACETS.antonym };
    case "+":
      return { type: "derivation", facet: RELATION_FACETS.derivation };
    case "@":
    case "@i":
      return { type: "hypernym", facet: RELATION_FACETS.hypernym };
    case "~":
    case "~i":
      return { type: "hyponym", facet: RELATION_FACETS.hyponym };
    default:
      return null;
  }
}

// A WordNet pointer's `sourceTarget` is four hex digits: the 1-based word number in the source synset the
// pointer leaves from, then the 1-based word number in the target synset it arrives at. `00` means the whole
// synset (a semantic pointer); a non-zero index means a specific word (a lexical pointer). Returns null for a
// malformed field so a corrupt pointer is skipped, never followed blindly.
export type PointerWordIndices = Readonly<{ source: number; target: number }>;

export function parsePointerWordIndices(raw: string): PointerWordIndices | null {
  if (!/^[0-9a-f]{4}$/iu.test(raw)) {
    return null;
  }
  return { source: parseInt(raw.slice(0, 2), 16), target: parseInt(raw.slice(2, 4), 16) };
}

// Clean one raw WordNet lemma into a comparable surface key: underscores (WordNet's space) become spaces,
// parenthetical markers like `(p)` are dropped, and the result is trimmed and lower-cased. A multi-word or
// empty lemma yields null so only single-word surfaces enter a relation set (this foundation excludes
// multi-word expressions).
export function normalizeLemmaKey(rawLemma: string): string | null {
  const cleaned = rawLemma
    .replace(/\(.*?\)/gu, "")
    .replace(/_/gu, " ")
    .trim()
    .toLowerCase();
  if (cleaned.length === 0 || /\s/u.test(cleaned)) {
    return null;
  }
  return cleaned;
}

// Attribute a candidate surface key to exactly one relation, respecting priority. Inflection is decided by
// the caller (it requires the lemmatizer, a Node dependency) and passed as a boolean; the remaining relations
// are pure set membership. Returns the first matching relation in priority order, or null when the key is
// unrelated. The caller must already have excluded the queried surface itself (exact material).
export function classifyLexicalRelation(
  key: string,
  relationSets: ReadonlyMap<LexicalRelationType, ReadonlySet<string>>,
  isInflection: boolean
): LexicalRelationType | null {
  for (const type of LEXICAL_RELATION_PRIORITY) {
    if (type === "inflection") {
      if (isInflection) {
        return "inflection";
      }
      continue;
    }
    if (relationSets.get(type)?.has(key) === true) {
      return type;
    }
  }
  return null;
}
