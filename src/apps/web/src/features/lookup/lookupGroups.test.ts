import { describe, expect, it } from "vitest";

import { groupSensesByPartOfSpeech } from "./lookupGroups";

describe("groupSensesByPartOfSpeech", () => {
  it("returns no groups for an empty sense list", () => {
    expect(groupSensesByPartOfSpeech([])).toEqual([]);
  });

  it("merges consecutive senses that share a part of speech", () => {
    expect(
      groupSensesByPartOfSpeech([
        { gloss: "to put in place", partOfSpeech: "verb" },
        { gloss: "to fix firmly", partOfSpeech: "verb" },
        { gloss: "a group of things", partOfSpeech: "noun" }
      ])
    ).toEqual([
      {
        partOfSpeech: "verb",
        senses: [
          { gloss: "to put in place", partOfSpeech: "verb" },
          { gloss: "to fix firmly", partOfSpeech: "verb" }
        ]
      },
      { partOfSpeech: "noun", senses: [{ gloss: "a group of things", partOfSpeech: "noun" }] }
    ]);
  });

  it("keeps a part-of-speech-less sense in its own group and does not merge a non-consecutive repeat", () => {
    const groups = groupSensesByPartOfSpeech([
      { gloss: "a plain gloss" },
      { gloss: "a noun sense", partOfSpeech: "noun" },
      { gloss: "a verb sense", partOfSpeech: "verb" },
      { gloss: "another noun sense", partOfSpeech: "noun" }
    ]);

    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.partOfSpeech)).toEqual([undefined, "noun", "verb", "noun"]);
  });
});
