import { describe, expect, it } from "vitest";

import type { ProductionJudgement } from "@whetstone/contracts";

import type { CoachProvider } from "./coachProvider.js";
import { createRoutedCoach, defaultCostRouting } from "./coachRouter.js";

// A coach whose every result is tagged with its name, so a routed call reveals which tier served it.
function tagged(tag: string, grade: 0 | 1 | 2 | 3 | 4 | 5): CoachProvider {
  return {
    authorCase: () => Promise.resolve({ chunks: [], communicativeFunction: tag, situation: tag }),
    converse: () => Promise.resolve({ say: tag }),
    gradeForScheduler: () => grade,
    judgeProduction: () =>
      Promise.resolve({
        category: "good",
        issues: [{ kind: "other", note: tag, severity: "minor" }],
        natural: 1
      }),
    proposeNext: () => Promise.resolve({ chunkId: null, cue: tag, target: tag })
  };
}

const strong = tagged("strong", 5);
const cheap = tagged("cheap", 1);

const judgement: ProductionJudgement = { category: "good", issues: [], natural: 1 };
const request = { context: { focus: "", recentTargets: [] }, target: "x", transcript: "x" };
const converseRequest = {
  communicativeFunction: "f",
  context: { focus: "", recentTargets: [] },
  history: [],
  situation: "s"
};

describe("createRoutedCoach (default routing)", () => {
  const coach = createRoutedCoach({ cheap, routing: defaultCostRouting, strong });

  it("routes judge to the strong tier", async () => {
    expect((await coach.judgeProduction(request)).issues[0]?.note).toBe("strong");
  });

  it("routes converse to the strong tier", async () => {
    expect((await coach.converse(converseRequest)).say).toBe("strong");
  });

  it("routes propose and author to the cheap tier", async () => {
    expect((await coach.proposeNext({ focus: "", recentTargets: [] })).target).toBe("cheap");
    expect((await coach.authorCase({ communicativeFunction: "f", situation: "s" })).situation).toBe(
      "cheap"
    );
  });

  it("grades through the strong tier without routing (tokenless)", () => {
    expect(coach.gradeForScheduler(judgement)).toBe(5);
  });
});

describe("createRoutedCoach (overridden routing)", () => {
  const coach = createRoutedCoach({
    cheap,
    routing: { author: "strong", converse: "cheap", judge: "cheap", propose: "strong" },
    strong
  });

  it("sends each call type to its configured tier", async () => {
    expect((await coach.judgeProduction(request)).issues[0]?.note).toBe("cheap");
    expect((await coach.converse(converseRequest)).say).toBe("cheap");
    expect((await coach.proposeNext({ focus: "", recentTargets: [] })).target).toBe("strong");
    expect((await coach.authorCase({ communicativeFunction: "f", situation: "s" })).situation).toBe(
      "strong"
    );
  });
});
