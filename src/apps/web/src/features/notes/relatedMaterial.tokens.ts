import type { LexicalPartOfSpeechDto, LexicalRelationTypeDto } from "@whetstone/contracts";

// Pure enum -> copy maps for the "Find related material" disclosure (#716). Restating a constant map in a
// test asserts nothing about behavior, so these live in a coverage-excluded `.tokens.ts` module; the
// disclosure's rendering (the reason each group shows, the "born -> bear . verb" header) is asserted through
// the real UI in the component test.

// The plain reason label for each typed relation that does NOT depend on the selected part of speech. The
// direction the service reports is already carried by the word (broader/narrower term), so the label alone is
// enough for the learner to read why a saved word connects.
const RELATION_REASON_LABEL: Readonly<
  Record<Exclude<LexicalRelationTypeDto, "inflection">, string>
> = {
  synonym: "synonym",
  antonym: "antonym",
  derivation: "derived form",
  hypernym: "broader term",
  hyponym: "narrower term"
};

// The reason label for one typed relation group. Inflection is labelled with the selected sense's part of
// speech ("same verb lemma") so a shared morphological lemma reads correctly; every other relation is fixed.
export function relationReasonLabel(
  relation: LexicalRelationTypeDto,
  partOfSpeech: LexicalPartOfSpeechDto
): string {
  return relation === "inflection" ? `same ${partOfSpeech} lemma` : RELATION_REASON_LABEL[relation];
}

// The part-of-speech word shown after a selected sense's lemma in the disclosure header ("bear . verb"). A
// direct pass-through today, kept here so a future presentation tweak never touches the component.
export function partOfSpeechLabel(partOfSpeech: LexicalPartOfSpeechDto): string {
  return partOfSpeech;
}
