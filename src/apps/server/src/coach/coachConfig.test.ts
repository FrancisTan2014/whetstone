import { describe, expect, it, vi } from "vitest";

import type { CoachProvider } from "./coachProvider.js";
import { readCoachConfig, resolveCoach } from "./coachConfig.js";
import { defaultCheapModel } from "./coachAdapters.js";
import { defaultCostRouting } from "./coachRouter.js";

function stub(tag: string): CoachProvider {
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
    ratingForScheduler: () => "again"
  };
}

describe("readCoachConfig", () => {
  it("is absent-config-safe: no env yields the default routing, model, and no key", () => {
    expect(readCoachConfig({})).toEqual({
      apiKey: undefined,
      converseModel: defaultCheapModel,
      routing: defaultCostRouting
    });
  });

  it("reads an API key, treating a blank one as absent", () => {
    expect(readCoachConfig({ COACH_API_KEY: "sk-123" }).apiKey).toBe("sk-123");
    expect(readCoachConfig({ COACH_API_KEY: "   " }).apiKey).toBeUndefined();
  });

  it("reads COACH_MODEL as the local converse model, trimming it and defaulting a blank one", () => {
    expect(readCoachConfig({ COACH_MODEL: "  mistral  " }).converseModel).toBe("mistral");
    expect(readCoachConfig({}).converseModel).toBe(defaultCheapModel);
    expect(readCoachConfig({ COACH_MODEL: "   " }).converseModel).toBe(defaultCheapModel);
  });

  it("applies per-call-type tier overrides", () => {
    const config = readCoachConfig({
      COACH_ANALYZE_TIER: "cheap",
      COACH_AUTHOR_TIER: "strong",
      COACH_CONVERSE_TIER: "cheap",
      COACH_JUDGE_TIER: "cheap",
      COACH_PROPOSE_TIER: "strong"
    });
    expect(config.routing).toEqual({
      analyze: "cheap",
      author: "strong",
      converse: "cheap",
      judge: "cheap",
      propose: "strong"
    });
  });

  it("rejects an unknown tier", () => {
    expect(() => readCoachConfig({ COACH_JUDGE_TIER: "medium" })).toThrow();
  });
});

describe("resolveCoach", () => {
  const fake = stub("fake");

  const knobs = {
    challenge: "medium" as const,
    focus: "f",
    pace: "steady" as const,
    probeErrorPatterns: [],
    register: "neutral" as const,
    support: "medium" as const,
    targetBand: "intermediate" as const
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
  const judgeRequest = { context: { focus: "", recentTargets: [] }, target: "x", transcript: "x" };

  it("falls back to the fake only when no adapter factory is wired", () => {
    const config = {
      apiKey: undefined,
      converseModel: defaultCheapModel,
      routing: defaultCostRouting
    };
    expect(resolveCoach({ config, fake })).toBe(fake);
  });

  it("builds the cost-routed adapters even with no key: cheap runs local, strong runs the fake", async () => {
    const createAdapters = vi.fn((apiKey: string | undefined) => {
      expect(apiKey).toBeUndefined();
      // With no key the strong tier is the fake; the cheap tier is the real local adapter.
      return { cheap: stub("local-cheap"), strong: stub("keyless-strong-fake") };
    });
    const config = {
      apiKey: undefined,
      converseModel: defaultCheapModel,
      routing: defaultCostRouting
    };

    const coach = resolveCoach({ config, createAdapters, fake });

    expect(coach).not.toBe(fake);
    expect(createAdapters).toHaveBeenCalledOnce();
    // Default routing sends converse/judge/propose/author to cheap (local) and analyze to strong.
    expect((await coach.judgeProduction(judgeRequest)).issues[0]?.note).toBe("local-cheap");
    expect((await coach.analyze(analyzeRequest)).encouragement).toBe("keyless-strong-fake");
  });

  it("builds the cost-routed real adapters from the key when both are present", async () => {
    const createAdapters = vi.fn((apiKey: string | undefined) => {
      expect(apiKey).toBe("sk-123");
      return { cheap: stub("cheap"), strong: stub("strong") };
    });
    const config = {
      apiKey: "sk-123",
      converseModel: defaultCheapModel,
      routing: defaultCostRouting
    };

    const coach = resolveCoach({ config, createAdapters, fake });

    expect(coach).not.toBe(fake);
    expect(createAdapters).toHaveBeenCalledOnce();
    // Default routing sends only analyze to the strong (cloud) tier.
    expect((await coach.judgeProduction(judgeRequest)).issues[0]?.note).toBe("cheap");
    expect((await coach.analyze(analyzeRequest)).encouragement).toBe("strong");
  });
});
