// Maps a part of speech to its color hue class for the lookup popover, so each
// part-of-speech section is visually distinct and scannable at a glance. A small, restrained
// palette (noun/verb/adjective/adverb) consistent with the design system; every other part of
// speech (and part-of-speech-less entries, e.g. CC-CEDICT) falls back to a neutral hue. The
// actual colors are Day/Night tokens defined in the stylesheet — never here.
const hueByPartOfSpeech: Readonly<Record<string, string>> = {
  adjective: "lookupPos--adjective",
  adverb: "lookupPos--adverb",
  noun: "lookupPos--noun",
  verb: "lookupPos--verb"
};

export function partOfSpeechHueClass(partOfSpeech: string | undefined): string {
  return hueByPartOfSpeech[partOfSpeech ?? ""] ?? "lookupPos--other";
}
