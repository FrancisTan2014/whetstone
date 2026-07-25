import type { LexicalPartOfSpeech } from "@whetstone/domain";

import lemmatize from "wink-lemmatizer";

// The morphology adapter for the lexical service (#715): reduce a surface to its dictionary lemma for a
// selected part of speech, so an inflected form (`mice`, `went`, `hotter`) can be matched to the base entry
// (`mouse`, `go`, `hot`). wink-lemmatizer ships rule + exception tables for noun, verb, and adjective;
// WordNet has no adverb lemmatizer, so an adverb is returned unchanged and matched by surface lookup only.
//
// The result is lower-cased for a stable lemma key. wink always returns a string (it strips known suffixes
// or echoes the input), so a lemma that no WordNet entry backs simply yields no senses downstream — the
// over-generation is harmless because a candidate is only ever surfaced as an explicit choice, never picked.
export type LexicalLemmatizer = (surface: string, pos: LexicalPartOfSpeech) => string;

export const winkLemmatizer: LexicalLemmatizer = (surface, pos) => {
  switch (pos) {
    case "noun":
      return lemmatize.noun(surface).toLowerCase();
    case "verb":
      return lemmatize.verb(surface).toLowerCase();
    case "adjective":
      return lemmatize.adjective(surface).toLowerCase();
    case "adverb":
      return surface.toLowerCase();
  }
};
