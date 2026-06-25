import type { NormalizedSense } from "@whetstone/contracts";

// A run of consecutive senses that share a part of speech, so the reader shows the label
// once per group instead of repeating (or concatenating) it on every sense.
export type LookupSenseGroup = Readonly<{
  partOfSpeech?: string | undefined;
  senses: ReadonlyArray<NormalizedSense>;
}>;

// Group consecutive senses by part of speech, preserving source order. Senses without a part
// of speech form their own group(s). Adapters emit senses already ordered by part of speech
// (one record/meaning at a time), so grouping consecutive runs keeps the source structure.
export function groupSensesByPartOfSpeech(
  senses: ReadonlyArray<NormalizedSense>
): ReadonlyArray<LookupSenseGroup> {
  const groups: LookupSenseGroup[] = [];

  for (const sense of senses) {
    const last = groups[groups.length - 1];

    if (last !== undefined && last.partOfSpeech === sense.partOfSpeech) {
      groups[groups.length - 1] = { ...last, senses: [...last.senses, sense] };
    } else {
      groups.push({ partOfSpeech: sense.partOfSpeech, senses: [sense] });
    }
  }

  return groups;
}
