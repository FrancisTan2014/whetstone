import { describe, expect, it } from "vitest";

import type { ProductionJudgement } from "@whetstone/contracts";
import type { ReviewRating } from "@whetstone/domain";

import type { CoachProvider } from "./coachProvider.js";
import { createRoutedCoach, defaultCostRouting } from "./coachRouter.js";

// A coach whose every result is tagged with its name, so a routed call reveals which tier served it.
function tagged(tag: string, rating: ReviewRating): CoachProvider {
  return {
    analyze: () =>
      Promise.resolve({
        chunkGrades: [],
        encouragement: tag,
        mistakes: [],
        upgrade: { native: tag, said: tag },
        wins: []
      }),
    authorCase: () => Promise.resolve({ chunks: [], communicativeFunction: tag, situation: tag }),
    converse: () => Promise.resolve({ say: tag }),
    judgeProduction: () =>
      Promise.resolve({
        category: "good",
        issues: [{ kind: "other", note: tag, severity: "minor" }],
        natural: 1
      }),
    proposeNext: () => Promise.resolve({ chunkId: null, cue: tag, target: tag }),
    ratingForScheduler: () => rating
  };
}

const strong = tagged("strong", "easy");
const cheap = tagged("cheap", "again");

const judgement: ProductionJudgement = { category: "good", issues: [], natural: 1 };
const knobs = {
  challenge: "medium" as const,
  focus: "f",
  pace: "steady" as const,
  probeErrorPatterns: [],
  register: "neutral" as const,
  support: "medium" as const,
  targetBand: "intermediate" as const
};
const request = { context: { focus: "", recentTargets: [] }, target: "x", transcript: "x" };
const converseRequest = {
  communicativeFunction: "f",
  context: { focus: "", recentTargets: [] },
  history: [],
  knobs,
  situation: "s"
};
const analyzeRequest = {
  communicativeFunction: "f",
  context: { profile: null, rankedChunks: [], recentOutcomes: [], relevantErrors: [] },
  history: [],
  knobs,
  situation: "s",
  targetChunks: [],
  words: []
};

describe("createRoutedCoach (default routing)", () => {
  const coach = createRoutedCoach({ cheap, routing: defaultCostRouting, strong });

  it("routes only analyze to the strong tier (the one paid judge call), converse cheap", async () => {
    expect((await coach.analyze(analyzeRequest)).encouragement).toBe("strong");
    expect((await coach.converse(converseRequest)).say).toBe("cheap");
  });

  it("routes judge, propose, and author to the cheap tier", async () => {
    expect((await coach.judgeProduction(request)).issues[0]?.note).toBe("cheap");
    expect((await coach.proposeNext({ focus: "", recentTargets: [] })).target).toBe("cheap");
    expect((await coach.authorCase({ communicativeFunction: "f", situation: "s" })).situation).toBe(
      "cheap"
    );
  });

  it("rates through the strong tier without routing (tokenless)", () => {
    expect(coach.ratingForScheduler(judgement)).toBe("easy");
  });
});

describe("createRoutedCoach (overridden routing)", () => {
  const coach = createRoutedCoach({
    cheap,
    routing: {
      analyze: "cheap",
      author: "strong",
      converse: "cheap",
      judge: "cheap",
      propose: "strong"
    },
    strong
  });

  it("sends each call type to its configured tier", async () => {
    expect((await coach.judgeProduction(request)).issues[0]?.note).toBe("cheap");
    expect((await coach.converse(converseRequest)).say).toBe("cheap");
    expect((await coach.analyze(analyzeRequest)).encouragement).toBe("cheap");
    expect((await coach.proposeNext({ focus: "", recentTargets: [] })).target).toBe("strong");
    expect((await coach.authorCase({ communicativeFunction: "f", situation: "s" })).situation).toBe(
      "strong"
    );
  });
});
