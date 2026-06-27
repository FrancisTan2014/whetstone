import { describe, expect, it } from "vitest";

import type { CompiledContext } from "@whetstone/contracts";

import { createFakeCoach } from "./fakeCoach.js";

const coach = createFakeCoach();

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
