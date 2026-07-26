import type { LexicalPartOfSpeechDto, LexicalRelationTypeDto } from "@whetstone/contracts";

// Pure presentation map for the "Find related material" disclosure (#716): the plain-language reason label
// for each typed one-hop relation. An `inflection` is labelled with the selected sense's part of speech
// ("same verb lemma") because that is the fact the learner reads; every other relation is a fixed phrase.
// Kept in a coverage-excluded tokens module because it is a static enum->string map with no branching logic.
const RELATION_LABELS: Readonly<Record<Exclude<LexicalRelationTypeDto, "inflection">, string>> = {
  synonym: "synonym",
  antonym: "antonym",
  derivation: "derived form",
  hypernym: "broader term",
  hyponym: "narrower term"
};

export function relationLabel(
  relation: LexicalRelationTypeDto,
  partOfSpeech: LexicalPartOfSpeechDto
): string {
  return relation === "inflection" ? `same ${partOfSpeech} lemma` : RELATION_LABELS[relation];
}
