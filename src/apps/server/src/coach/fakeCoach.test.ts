import { describe, expect, it } from "vitest";

import type { CoachKnobs, CompiledContext } from "@whetstone/contracts";

import { createFakeCoach } from "./fakeCoach.js";

const coach = createFakeCoach();

const knobs: CoachKnobs = {
  challenge: "medium",
  focus: "kitchen.offering-food",
  l1: "none",
  pace: "steady",
  probeErrorPatterns: [],
  register: "neutral",
  support: "medium",
  targetBand: "intermediate",
  targetL1Share: 0
};

function judge(target: string, transcript: string) {
  return coach.judgeProduction({
    context: { focus: "", recentTargets: [] },
    target,
    transcript
  });
}

describe("FakeCoach judgeProduction", () => {
  it("is off_target with no issues for an empty transcript", async () => {
    expect(await judge("spill the beans", "   ")).toEqual({
      category: "off_target",
      issues: [],
      natural: 0
    });
  });

  it("is native_like for an exact (normalized) match", async () => {
    expect(await judge("How's it going", "  how's   it going ")).toEqual({
      category: "native_like",
      issues: [],
      natural: 1
    });
  });

  it("is off_target with a major issue when no target word lands", async () => {
    const judgement = await judge("spill the beans", "totally unrelated");
    expect(judgement.category).toBe("off_target");
    expect(judgement.natural).toBe(0);
    expect(judgement.issues).toEqual([
      { kind: "word_choice", note: "Missing key words: spill, the, beans.", severity: "major" }
    ]);
  });

  it("is incorrect with a major issue below half overlap", async () => {
    const judgement = await judge("spill the beans now", "now");
    expect(judgement).toMatchObject({ category: "incorrect", natural: 0.25 });
    expect(judgement.issues[0]?.severity).toBe("major");
  });

  it("is awkward with a minor issue at half overlap", async () => {
    const judgement = await judge("spill the beans now", "spill the");
    expect(judgement).toMatchObject({ category: "awkward", natural: 0.5 });
    expect(judgement.issues[0]?.severity).toBe("minor");
  });

  it("is understandable just below full overlap", async () => {
    expect(await judge("spill the beans now", "spill the beans")).toMatchObject({
      category: "understandable",
      natural: 0.75
    });
  });

  it("is good with no issues when every target word is present but reworded", async () => {
    expect(await judge("spill the beans", "please spill the beans now")).toEqual({
      category: "good",
      issues: [],
      natural: 1
    });
  });

  it("is off_target when the target has no words to match", async () => {
    expect(await judge("!!!", "hello there")).toEqual({
      category: "off_target",
      issues: [],
      natural: 0
    });
  });

  it("is deterministic — the same input judges identically", async () => {
    expect(await judge("spill the beans now", "spill the")).toEqual(
      await judge("spill the beans now", "spill the")
    );
  });
});

describe("FakeCoach gradeForScheduler", () => {
  it("grades a native-like judgement as a perfect SM-2 5", async () => {
    const judgement = await judge("How's it going", "how's it going");
    expect(coach.gradeForScheduler(judgement)).toBe(5);
  });

  it("grades an off-target judgement as 0", async () => {
    const judgement = await judge("spill the beans", "   ");
    expect(coach.gradeForScheduler(judgement)).toBe(0);
  });
});

describe("FakeCoach proposeNext", () => {
  it("proposes the focus as the target when present", async () => {
    const result = await coach.proposeNext({ focus: "ordering coffee", recentTargets: [] });
    expect(result).toEqual({
      chunkId: null,
      cue: "Say something natural for: ordering coffee",
      target: "ordering coffee"
    });
  });

  it("falls back to the most recent target when there is no focus", async () => {
    const context: CompiledContext = { focus: "  ", recentTargets: ["Help yourself."] };
    expect((await coach.proposeNext(context)).target).toBe("Help yourself.");
  });

  it("uses a safe default when nothing is in context", async () => {
    expect((await coach.proposeNext({ focus: "", recentTargets: [] })).target).toBe(
      "How's it going?"
    );
  });
});

describe("FakeCoach authorCase", () => {
  it("authors a deterministic case and chunk inventory from the brief", async () => {
    const result = await coach.authorCase({
      communicativeFunction: "Offering food",
      situation: "At the table"
    });

    expect(result.situation).toBe("At the table");
    expect(result.communicativeFunction).toBe("Offering food");
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]?.text).toBe("Could we talk about At the table?");
    expect(result.chunks[1]?.text).toBe("I'd like to offering food.");
  });
});

describe("FakeCoach converse", () => {
  const base = {
    communicativeFunction: "Offering food",
    context: { focus: "At the table", recentTargets: [] },
    knobs,
    situation: "At the table"
  } as const;

  it("opens the call in flow with no repair when there is no history", async () => {
    const result = await coach.converse({ ...base, history: [] });

    expect(result).toEqual({ say: "Let's get into it: At the table. How would you start?" });
    expect(result.repair).toBeUndefined();
  });

  it("stays in flow with a follow-up and no repair on a normal user turn", async () => {
    const result = await coach.converse({
      ...base,
      history: [
        { role: "coach", text: "Let's get into it." },
        { role: "user", text: "Sure, help yourself to some rice." }
      ]
    });

    expect(result.say).toBe("Good — keep going. What would you say next?");
    expect(result.repair).toBeUndefined();
  });

  it("steps out of character to reorient (not a language repair) on an empty/near-empty turn (#437)", async () => {
    const result = await coach.converse({
      ...base,
      history: [
        { role: "coach", text: "How would you offer them food?" },
        { role: "user", text: "  ...  " }
      ]
    });

    // Reorientation names the role-play, and is NOT a language repair.
    expect(result.repair).toBeUndefined();
    expect(result.say).toContain("this is a role-play");
    expect(result.say).toContain("At the table");
    // With no usable target phrase, the example is a safe generic natural line - never a malformed
    // transform of the communicative-function label.
    expect(result.say).toContain("I'm not sure how to start, but here goes.");
    expect(result.say).not.toContain("offering food");
  });

  it("uses a real usable target phrase as the reorientation example when one is available (#437)", async () => {
    const result = await coach.converse({
      ...base,
      context: { focus: "At the table", recentTargets: ["", "Help yourself."] },
      history: [{ role: "user", text: "what are you talking about?" }]
    });

    expect(result.repair).toBeUndefined();
    expect(result.say).toContain('for example "Help yourself."');
  });

  it("reorients on a clear confusion/meta turn, and only once per stuck stretch (#437)", async () => {
    const confused = await coach.converse({
      ...base,
      history: [
        { role: "coach", text: "Let's get into it: At the table. How would you start?" },
        { role: "user", text: "What are you talking about? You're just talking to yourself." }
      ]
    });
    expect(confused.repair).toBeUndefined();
    expect(confused.say).toContain("this is a role-play");

    // A repeated confusion turn right after a reorientation does NOT reorient again (no loop).
    const again = await coach.converse({
      ...base,
      history: [
        { role: "user", text: "What are you talking about?" },
        { role: "coach", text: confused.say },
        { role: "user", text: "I still don't understand." }
      ]
    });
    expect(again.say).not.toContain("this is a role-play");
  });

  it("is deterministic — the same conversation converses identically", async () => {
    const request = { ...base, history: [{ role: "user" as const, text: "Have some tea." }] };

    expect(await coach.converse(request)).toEqual(await coach.converse(request));
  });

  it("pushes one English target when the bilingual dial is on (#270)", async () => {
    const bilingual = { ...base, knobs: { ...knobs, l1: "zh", targetL1Share: 0.5 } } as const;

    const flow = await coach.converse({
      ...bilingual,
      history: [{ role: "user" as const, text: "我想点菜。" }]
    });
    expect(flow.englishTarget?.length).toBeGreaterThan(0);

    // A confusion turn (no usable words) in bilingual mode reorients and still pushes an English target.
    const breakdown = await coach.converse({
      ...bilingual,
      history: [{ role: "user" as const, text: "  ...  " }]
    });
    expect(breakdown.repair).toBeUndefined();
    expect(breakdown.say).toContain("role-play");
    expect(breakdown.englishTarget?.length).toBeGreaterThan(0);

    // The English-only path carries no target.
    const englishOnly = await coach.converse({
      ...base,
      history: [{ role: "user" as const, text: "I'd like to order." }]
    });
    expect(englishOnly.englishTarget).toBeUndefined();
  });
});

describe("FakeCoach analyze", () => {
  const base = {
    communicativeFunction: "Offering food",
    context: { profile: null, rankedChunks: [], recentOutcomes: [], relevantErrors: [] },
    knobs,
    situation: "At the table",
    words: []
  } as const;

  const request = {
    ...base,
    history: [
      { role: "coach" as const, text: "How would you offer them food?" },
      { role: "user" as const, text: "Help yourself to some rice." }
    ],
    targetChunks: [
      { chunkId: "c1", text: "Help yourself." },
      { chunkId: "c2", text: "Would you like some more?" }
    ]
  };

  it("grades each target chunk, wins the produced one, and flags the missing one as a tagged mistake", async () => {
    const result = await coach.analyze(request);

    expect(result.chunkGrades).toHaveLength(2);
    const produced = result.chunkGrades.find((grade) => grade.chunkId === "c1");
    const missing = result.chunkGrades.find((grade) => grade.chunkId === "c2");
    expect(produced?.grade).toBeGreaterThanOrEqual(4);
    expect(missing?.grade).toBeLessThan(3);

    expect(result.wins).toContain('Nailed "Help yourself.".');
    expect(result.mistakes).toHaveLength(1);
    expect(result.mistakes[0]).toMatchObject({
      category: "word_order",
      native: "Would you like some more?",
      said: "Help yourself to some rice."
    });
    expect(result.upgrade.native).toBe("Help yourself.");
    expect(result.encouragement.length).toBeGreaterThan(0);
  });

  it("tags a short missing chunk as an L1 calque and caps mistakes at three", async () => {
    const result = await coach.analyze({
      ...base,
      history: [{ role: "user" as const, text: "totally unrelated words" }],
      targetChunks: [
        { chunkId: "a", text: "Dig in." },
        { chunkId: "b", text: "Help yourself to more." },
        { chunkId: "c", text: "Make yourself at home." },
        { chunkId: "d", text: "Would you like a drink?" }
      ]
    });

    expect(result.mistakes).toHaveLength(3);
    expect(result.mistakes.some((mistake) => mistake.category === "l1_calque")).toBe(true);
    expect(result.wins).toEqual([]);
  });

  it("handles an empty round (no user words, no target chunks) with safe fallbacks", async () => {
    const result = await coach.analyze({
      ...base,
      history: [{ role: "coach" as const, text: "Hello?" }],
      targetChunks: []
    });

    expect(result.chunkGrades).toEqual([]);
    expect(result.mistakes).toEqual([]);
    expect(result.upgrade).toEqual({
      native: "Keep it natural and concrete.",
      said: "what you tried"
    });
  });

  it("is deterministic — the same round analyses identically", async () => {
    expect(await coach.analyze(request)).toEqual(await coach.analyze(request));
  });
});
