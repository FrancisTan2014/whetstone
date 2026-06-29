import { describe, expect, it, vi } from "vitest";

import type { AnalyzeRoundRequest, CoachKnobs } from "@whetstone/contracts";

import { createFakeCoach } from "./fakeCoach.js";
import { createLlmCoach } from "./llmCoach.js";

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

const request: AnalyzeRoundRequest = {
  communicativeFunction: "Offering food",
  context: { profile: null, rankedChunks: [], recentOutcomes: [], relevantErrors: [] },
  history: [{ role: "user", text: "Help yourself to some rice" }],
  knobs,
  situation: "At the table",
  targetChunks: [{ chunkId: "c1", text: "Help yourself." }],
  words: []
};

const judgeJson =
  '{"chunkGrades":[{"chunkId":"c1","grade":5}],"mistakes":[],"wins":["Clear and natural"],' +
  '"upgrade":{"said":"help yourself","native":"Help yourself."},"encouragement":"Understood you."}';

describe("createLlmCoach analyze", () => {
  it("grades an intelligible-but-accented attempt high, parsing the model's JSON", async () => {
    const chat = vi.fn().mockResolvedValue(`Here you go: ${judgeJson} done.`);
    const coach = createLlmCoach({ chat, fallback: createFakeCoach() });

    const result = await coach.analyze(request);
    expect(result.chunkGrades).toEqual([{ chunkId: "c1", grade: 5 }]);
    expect(result.encouragement).toBe("Understood you.");
    // The prompt is intelligibility-first and never penalizes accent.
    expect((chat.mock.calls[0]?.[0] as string).toLowerCase()).toContain("intelligibility");
  });

  it("degrades to the deterministic fallback when the model output is unusable", async () => {
    const coach = createLlmCoach({
      chat: vi.fn().mockResolvedValue("not json"),
      fallback: createFakeCoach()
    });

    const result = await coach.analyze(request);
    // Fallback graded the produced chunk, so the round still grades.
    expect(result.chunkGrades).toHaveLength(1);
  });

  it("delegates non-analyze calls to the fallback", async () => {
    const coach = createLlmCoach({ chat: vi.fn(), fallback: createFakeCoach() });
    expect(
      (await coach.proposeNext({ focus: "x", recentTargets: [] })).target.length
    ).toBeGreaterThan(0);
    expect(coach.gradeForScheduler({ category: "good", issues: [], natural: 1 })).toBeGreaterThan(
      0
    );
    expect((await coach.authorCase({ communicativeFunction: "f", situation: "s" })).situation).toBe(
      "s"
    );
    expect((await coach.converse({ ...request, history: [] })).say.length).toBeGreaterThan(0);
    expect(
      (
        await coach.judgeProduction({
          context:
            request.context.profile === null
              ? { focus: "x", recentTargets: [] }
              : { focus: "x", recentTargets: [] },
          target: "hi",
          transcript: "hi"
        })
      ).category
    ).toBe("native_like");
  });
});

describe("createLlmCoach converse", () => {
  const converseRequest = {
    communicativeFunction: "Offering food",
    context: { focus: "table", recentTargets: [] },
    history: [{ role: "user" as const, text: "I want give you food" }],
    knobs,
    situation: "At the table"
  };

  it("returns the model's in-flow line with a recast on breakdown, no grade", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue(
        '{"say":"Nice — would you offer some?","repair":{"reason":"stuck","recast":"Try: help yourself"}}'
      );
    const coach = createLlmCoach({ chat, fallback: createFakeCoach() });

    const result = await coach.converse(converseRequest);
    expect(result.say).toContain("offer");
    expect(result.repair?.recast).toContain("help yourself");
    expect((chat.mock.calls[0]?.[0] as string).toLowerCase()).toContain("register");
  });

  it("falls back to the deterministic turn when output is unusable", async () => {
    const coach = createLlmCoach({
      chat: vi.fn().mockResolvedValue("???"),
      fallback: createFakeCoach()
    });
    expect((await coach.converse(converseRequest)).say.length).toBeGreaterThan(0);
  });

  it("briefs a bilingual mix and returns the pushed English target (#270)", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue('{"say":"好的 — 我们试试英文。","englishTarget":"Help yourself."}');
    const coach = createLlmCoach({ chat, fallback: createFakeCoach() });

    const result = await coach.converse({
      ...converseRequest,
      knobs: { ...knobs, l1: "zh", targetL1Share: 0.5 }
    });

    expect(result.englishTarget).toBe("Help yourself.");
    const prompt = (chat.mock.calls[0]?.[0] as string).toLowerCase();
    expect(prompt).toContain("bilingual");
    expect(prompt).toContain("englishtarget");
  });
});
